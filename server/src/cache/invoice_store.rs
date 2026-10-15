use anyhow::{Context, ensure};
use bitcoin::{Network, hashes::{sha256, Hash}};
use deadpool_redis::redis::cmd;
use lightning_invoice::{Bolt11Invoice, Bolt11InvoiceDescriptionRef, Currency};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

use super::redis_client::RedisClient;

const INVOICE_PREFIX: &str = "invoice:";
const INVOICE_TTL_SECONDS: u64 = 60;
const MAX_CONTEXT_BYTES: usize = 32 * 1024;
const MAX_INVOICE_BYTES: usize = 16 * 1024;

// Compare the complete validated context and retain its original expiry. A
// concurrent assignment is reread; never overwrite an assigned invoice.
const ASSIGN: &str = r#"
local current = redis.call('GET', KEYS[1])
if not current then return -1 end
if current ~= ARGV[1] then return 0 end
if redis.call('PTTL', KEYS[1]) <= 0 then return -1 end
if current ~= ARGV[2] then
  redis.call('SET', KEYS[1], ARGV[2], 'XX', 'KEEPTTL')
end
return 1
"#;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvoiceRequestContext {
    version: u8,
    owner: String,
    amount_msat: u64,
    description_hash: String,
    network: String,
    invoice: Option<String>,
}

impl InvoiceRequestContext {
    pub fn new(owner: String, amount_msat: u64, description_hash: sha256::Hash, network: Network) -> Self {
        Self { version: 1, owner, amount_msat, description_hash: description_hash.to_string(),
            network: network.to_string(), invoice: None }
    }

    fn validate(&self) -> anyhow::Result<()> {
        ensure!(self.version == 1 && !self.owner.is_empty() && self.owner.len() <= 256,
            "Unsupported invoice request context");
        ensure!(self.amount_msat > 0 && self.amount_msat <= 1_000_000_000 && self.amount_msat % 1000 == 0,
            "Invalid invoice request amount");
        ensure!(self.description_hash.len() == 64 && self.description_hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid invoice request hash");
        Network::from_str(&self.network).context("Invalid invoice request network")?;
        Ok(())
    }

    fn validate_invoice(&self, invoice: &str) -> anyhow::Result<()> {
        ensure!(invoice.len() <= MAX_INVOICE_BYTES, "Invoice is too large");
        validate_lnurl_invoice(invoice, self.amount_msat,
            sha256::Hash::from_str(&self.description_hash)?, Network::from_str(&self.network)?)
    }
}

pub(crate) fn validate_lnurl_invoice(
    invoice: &str, amount_msat: u64, metadata_hash: sha256::Hash, network: Network,
) -> anyhow::Result<()> {
    let invoice: Bolt11Invoice = invoice.parse().context("Invalid device BOLT11 invoice")?;
    invoice.check_signature().context("Invalid device invoice signature")?;
    ensure!(!invoice.is_expired(), "Device invoice has expired");
    // network() collapses Simnet into Regtest in lightning-invoice 0.34.
    // Compare the actual BOLT11 currency so that alias cannot cross this gate.
    ensure!(matches!((network, invoice.currency()),
        (Network::Bitcoin, Currency::Bitcoin) | (Network::Testnet, Currency::BitcoinTestnet) |
        (Network::Signet, Currency::Signet) | (Network::Regtest, Currency::Regtest)),
        "Device invoice network mismatch");
    ensure!(invoice.amount_milli_satoshis() == Some(amount_msat), "Device invoice amount mismatch");
    ensure!(matches!(invoice.description(), Bolt11InvoiceDescriptionRef::Hash(hash) if hash.0 == metadata_hash),
        "Device invoice does not commit to the advertised LNURL metadata");
    Ok(())
}

#[derive(Clone)]
pub struct InvoiceStore { client: RedisClient }

impl InvoiceStore {
    pub fn new(client: RedisClient) -> Self { Self { client } }

    fn key(transaction_id: &str) -> anyhow::Result<String> {
        let id = uuid::Uuid::parse_str(transaction_id).context("Invalid invoice request ID")?;
        ensure!(id.to_string() == transaction_id, "Noncanonical invoice request ID");
        Ok(format!("{}{}", INVOICE_PREFIX, transaction_id))
    }

    pub async fn create_request(&self, transaction_id: &str, context: InvoiceRequestContext) -> anyhow::Result<()> {
        context.validate()?;
        ensure!(context.invoice.is_none(), "Invoice request must start pending");
        let key = Self::key(transaction_id)?;
        let raw = serde_json::to_string(&context)?;
        let mut conn = self.client.get_connection().await?;
        let created: Option<String> = cmd("SET").arg(&key).arg(raw).arg("NX").arg("EX")
            .arg(INVOICE_TTL_SECONDS).query_async(&mut conn).await?;
        ensure!(created.is_some(), "Invoice request already exists");
        Ok(())
    }

    async fn read(&self, transaction_id: &str) -> anyhow::Result<(InvoiceRequestContext, String)> {
        let key = Self::key(transaction_id)?;
        let mut conn = self.client.get_connection().await?;
        // Read value and lifetime together; legacy unbounded/nonexpiring keys
        // cannot become valid requests just because their JSON looks similar.
        let (raw, ttl): (Option<String>, i64) = cmd("EVAL")
            .arg("local ttl=redis.call('PTTL',KEYS[1]); if ttl<=0 or ttl>60000 or redis.call('STRLEN',KEYS[1])>tonumber(ARGV[1]) then return {false,ttl} end; return {redis.call('GET',KEYS[1]),ttl}")
            .arg(1).arg(&key).arg(MAX_CONTEXT_BYTES).query_async(&mut conn).await?;
        ensure!(ttl > 0 && ttl <= 60_000, "Invoice request is missing, expired or has invalid lifetime; request a new invoice");
        let raw = raw.context("Invoice request is missing or invalid; request a new invoice")?;
        ensure!(raw.len() <= MAX_CONTEXT_BYTES, "Invoice request context is too large");
        let context: InvoiceRequestContext = serde_json::from_str(&raw)
            .context("Legacy or invalid invoice request context; request a new invoice")?;
        context.validate()?;
        Ok((context, raw))
    }

    pub async fn assign(&self, transaction_id: &str, owner: &str, invoice: &str) -> anyhow::Result<()> {
        for _ in 0..4 {
            let (mut context, before) = self.read(transaction_id).await?;
            ensure!(context.owner == owner, "Invoice request belongs to another user");
            context.validate_invoice(invoice)?;
            if let Some(assigned) = &context.invoice {
                ensure!(assigned == invoice, "Invoice request already has a different invoice");
            } else {
                context.invoice = Some(invoice.to_string());
            }
            let after = serde_json::to_string(&context)?;
            let mut conn = self.client.get_connection().await?;
            let result: i64 = cmd("EVAL").arg(ASSIGN).arg(1).arg(Self::key(transaction_id)?)
                .arg(before).arg(after).query_async(&mut conn).await?;
            match result {
                1 => return Ok(()),
                -1 => anyhow::bail!("Invoice request expired; request a new invoice"),
                _ => continue,
            }
        }
        anyhow::bail!("Invoice request changed concurrently; retry the identical invoice")
    }

    // Polling is read-only: repeated rightful reads remain possible until the
    // original TTL. Neither a read nor an identical submit extends that TTL.
    pub async fn get(&self, transaction_id: &str, owner: &str) -> anyhow::Result<Option<String>> {
        let (context, _) = self.read(transaction_id).await?;
        ensure!(context.owner == owner, "Invoice request belongs to another user");
        if let Some(invoice) = &context.invoice { context.validate_invoice(invoice)?; }
        Ok(context.invoice)
    }
}
