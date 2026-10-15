use axum::{Router, body::Body, http::{self, Request, StatusCode}};
use bitcoin::{Network, hashes::{sha256, Hash}, secp256k1::{Secp256k1, SecretKey}};
use deadpool_redis::redis::{AsyncCommands, cmd};
use lightning_invoice::{Currency, InvoiceBuilder, PaymentSecret};
use serde_json::json;
use tower::ServiceExt;
use crate::{AppState, cache::{invoice_store::InvoiceRequestContext, redis_client::RedisClient}};
use crate::tests::common::{TestUser, setup_test_app};

fn digest() -> sha256::Hash { sha256::Hash::hash(b"public LNURL metadata fixture") }
fn invoice(network: Network, amount: u64, hash: Option<sha256::Hash>, nonce: u8) -> String {
    let builder = InvoiceBuilder::new(Currency::from(network));
    let builder = match hash {
        Some(hash) => builder.description_hash(hash),
        None => builder.description("plain memo is not a metadata hash".to_string()),
    };
    builder.payment_hash(sha256::Hash::from_byte_array([nonce; 32]))
        .payment_secret(PaymentSecret([2; 32])).current_timestamp()
        .min_final_cltv_expiry_delta(18).amount_milli_satoshis(amount)
        .build_signed(|hash| Secp256k1::new().sign_ecdsa_recoverable(hash, &SecretKey::from_slice(&[3; 32]).unwrap()))
        .unwrap().to_string()
}
async fn user(state: &AppState) -> (TestUser, String) {
    let user = TestUser::new();
    sqlx::query("INSERT INTO users (pubkey, lightning_address) VALUES ($1, $2)")
        .bind(user.pubkey().to_string()).bind(format!("test-{}@localhost", uuid::Uuid::new_v4()))
        .execute(&state.db_pool).await.unwrap();
    let token = user.access_token(state);
    (user, token)
}
async fn submit(app: Router, token: Option<&str>, id: &str, invoice: &str) -> StatusCode {
    let mut request = Request::builder().method(http::Method::POST)
        .uri("/lnurlp/submit_invoice").header(http::header::CONTENT_TYPE, "application/json");
    if let Some(token) = token { request = request.header(http::header::AUTHORIZATION, format!("Bearer {token}")); }
    app.oneshot(request.body(Body::from(serde_json::to_vec(&json!({
        "transaction_id": id, "invoice": invoice,
    })).unwrap())).unwrap()).await.unwrap().status()
}
async fn connection(state: &AppState) -> deadpool_redis::Connection {
    RedisClient::new(&state.config.redis_url).unwrap().get_connection().await.unwrap()
}
async fn pending(state: &AppState, owner: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    state.invoice_store.create_request(&id, InvoiceRequestContext::new(owner.to_string(), 100_000, digest(), Network::Regtest))
        .await.unwrap();
    id
}

#[tokio::test]
async fn lnurl_request_owner_and_identical_retry_preserve_assignment_and_ttl() {
    let (app, state, _guard) = setup_test_app().await;
    let (a, token_a) = user(&state).await;
    let (b, token_b) = user(&state).await;
    let owner = a.pubkey().to_string();
    let id = pending(&state, &owner).await;
    let key = format!("invoice:{id}");
    let mut conn = connection(&state).await;
    let before: String = conn.get(&key).await.unwrap();
    let ttl_before: i64 = conn.pttl(&key).await.unwrap();
    let first = invoice(Network::Regtest, 100_000, Some(digest()), 1);
    assert_eq!(submit(app.clone(), Some(&token_b), &id, &first).await, StatusCode::BAD_REQUEST);
    assert_eq!(conn.get::<_, String>(&key).await.unwrap(), before);
    assert!(state.invoice_store.get(&id, &b.pubkey().to_string()).await.is_err());
    assert_eq!(state.invoice_store.get(&id, &owner).await.unwrap(), None);
    assert_eq!(submit(app.clone(), Some(&token_a), &id, &first).await, StatusCode::OK);
    let assigned: String = conn.get(&key).await.unwrap();
    assert_eq!(submit(app.clone(), Some(&token_a), &id, &first).await, StatusCode::OK);
    let second = invoice(Network::Regtest, 100_000, Some(digest()), 2);
    assert_eq!(submit(app.clone(), Some(&token_a), &id, &second).await, StatusCode::BAD_REQUEST);
    assert_eq!(submit(app, Some(&token_b), &id, &first).await, StatusCode::BAD_REQUEST);
    assert_eq!(conn.get::<_, String>(&key).await.unwrap(), assigned);
    for _ in 0..2 { assert_eq!(state.invoice_store.get(&id, &owner).await.unwrap(), Some(first.clone())); }
    let ttl_after: i64 = conn.pttl(&key).await.unwrap();
    assert!(ttl_after > 0 && ttl_after <= ttl_before && ttl_before <= 60_000);
}

#[tokio::test]
async fn lnurl_request_wrong_hash_amount_network_and_malformed_do_not_consume() {
    let (app, state, _guard) = setup_test_app().await;
    let (a, token) = user(&state).await;
    let owner = a.pubkey().to_string();
    let id = pending(&state, &owner).await;
    let mut conn = connection(&state).await;
    let key = format!("invoice:{id}");
    let before: String = conn.get(&key).await.unwrap();
    for wrong in [
        invoice(Network::Regtest, 100_000, None, 1),
        invoice(Network::Regtest, 100_000, Some(sha256::Hash::hash(b"other metadata")), 2),
        invoice(Network::Regtest, 101_000, Some(digest()), 3),
        invoice(Network::Bitcoin, 100_000, Some(digest()), 4),
        "not-a-bolt11-invoice".to_string(),
    ] {
        assert_eq!(submit(app.clone(), Some(&token), &id, &wrong).await, StatusCode::BAD_REQUEST);
        assert_eq!(conn.get::<_, String>(&key).await.unwrap(), before);
        assert_eq!(state.invoice_store.get(&id, &owner).await.unwrap(), None);
    }
    let valid = invoice(Network::Regtest, 100_000, Some(digest()), 5);
    assert_eq!(submit(app, Some(&token), &id, &valid).await, StatusCode::OK);
}

#[tokio::test]
async fn lnurl_request_concurrent_assignments_cannot_replace_winner() {
    let (_app, state, _guard) = setup_test_app().await;
    let (a, _) = user(&state).await;
    let owner = a.pubkey().to_string();
    let id = pending(&state, &owner).await;
    let first = invoice(Network::Regtest, 100_000, Some(digest()), 1);
    let second = invoice(Network::Regtest, 100_000, Some(digest()), 2);
    let (a, b) = tokio::join!(state.invoice_store.assign(&id, &owner, &first), state.invoice_store.assign(&id, &owner, &second));
    assert_ne!(a.is_ok(), b.is_ok());
    let winner = if a.is_ok() { first } else { second };
    assert_eq!(state.invoice_store.get(&id, &owner).await.unwrap(), Some(winner.clone()));
    state.invoice_store.assign(&id, &owner, &winner).await.unwrap();
    assert_eq!(state.invoice_store.get(&id, &owner).await.unwrap(), Some(winner.clone()));
    let retry_id = pending(&state, &owner).await;
    let (a, b) = tokio::join!(state.invoice_store.assign(&retry_id, &owner, &winner), state.invoice_store.assign(&retry_id, &owner, &winner));
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(state.invoice_store.get(&retry_id, &owner).await.unwrap(), Some(winner));
}

#[tokio::test]
async fn lnurl_request_missing_expired_legacy_and_invalid_context_fail_closed() {
    let (_app, state, _guard) = setup_test_app().await;
    let (a, _) = user(&state).await;
    let owner = a.pubkey().to_string();
    let valid = invoice(Network::Regtest, 100_000, Some(digest()), 1);
    let missing = uuid::Uuid::new_v4().to_string();
    assert!(state.invoice_store.assign(&missing, &owner, &valid).await.is_err());
    let mut conn = connection(&state).await;
    for raw in ["legacy-raw-invoice".to_string(), "{}".to_string(), {
        let mut context = serde_json::to_value(InvoiceRequestContext::new(owner.clone(), 100_000, digest(), Network::Regtest)).unwrap();
        context["version"] = json!(2); context.to_string()
    }] {
        let id = uuid::Uuid::new_v4().to_string(); let key = format!("invoice:{id}");
        let _: () = conn.set_ex(&key, &raw, 60).await.unwrap();
        assert!(state.invoice_store.assign(&id, &owner, &valid).await.is_err());
        assert!(state.invoice_store.get(&id, &owner).await.is_err());
        assert_eq!(conn.get::<_, String>(&key).await.unwrap(), raw);
    }
    let unbounded = pending(&state, &owner).await; let key = format!("invoice:{unbounded}");
    let _: i64 = cmd("PERSIST").arg(&key).query_async(&mut conn).await.unwrap();
    let before: String = conn.get(&key).await.unwrap();
    assert!(state.invoice_store.assign(&unbounded, &owner, &valid).await.is_err());
    assert!(state.invoice_store.get(&unbounded, &owner).await.is_err());
    assert_eq!(conn.get::<_, String>(&key).await.unwrap(), before);
    let id = pending(&state, &owner).await; let key = format!("invoice:{id}");
    let _: i64 = cmd("PEXPIRE").arg(&key).arg(1).query_async(&mut conn).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    assert!(state.invoice_store.assign(&id, &owner, &valid).await.is_err());
    assert!(state.invoice_store.get(&id, &owner).await.is_err());
    assert!(!conn.exists::<_, bool>(&key).await.unwrap());
}

#[tokio::test]
async fn lnurl_request_requires_authenticated_existing_user() {
    let (app, state, _guard) = setup_test_app().await;
    let unknown = TestUser::new(); let token = unknown.access_token(&state);
    let id = uuid::Uuid::new_v4().to_string();
    assert_eq!(submit(app.clone(), None, &id, "public invalid invoice").await, StatusCode::UNAUTHORIZED);
    assert_eq!(submit(app, Some(&token), &id, "public invalid invoice").await, StatusCode::UNAUTHORIZED);
}
