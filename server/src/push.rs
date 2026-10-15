use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use expo_push_notification_client::{Expo, ExpoClientOptions, ExpoPushMessage, Priority};
use futures_util::{StreamExt, stream};
use reqwest::{Client, Url, redirect::Policy};
use serde::Serialize;
use tokio::{net::lookup_host, time::timeout};

use crate::{
    AppState, db::push_token_repo::PushTokenRepository, errors::ApiError,
    types::NotificationRequestData, utils::make_k1,
};

const UNIFIED_PUSH_ENDPOINT_MAX_BYTES: usize = 1_000;
const UNIFIED_PUSH_DNS_TIMEOUT: Duration = Duration::from_secs(3);
const UNIFIED_PUSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const UNIFIED_PUSH_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const UNIFIED_PUSH_CONCURRENCY_LIMIT: usize = 16;

// This clone is used only by the isolated integration harness. The test flag
// changes transport endpoints, not recipient selection, payloads or k1 handling.
fn integration_test_mode() -> bool {
    std::env::var("NOAH_INTEGRATION_TEST").as_deref() == Ok("1")
}

fn loopback_host(host: &str) -> bool {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback())
}

fn local_expo_origin(origin: &str) -> Result<Url, ApiError> {
    let url = Url::parse(origin)
        .map_err(|_| ApiError::InvalidArgument("Invalid local Expo origin".to_string()))?;
    if url.scheme() != "http"
        || !url.host_str().is_some_and(loopback_host)
        || url.port().is_none_or(|port| port == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::InvalidArgument(
            "Invalid local Expo origin".to_string(),
        ));
    }
    Ok(url)
}

fn expo_client(access_token: &str) -> Result<Expo, ApiError> {
    if integration_test_mode() {
        let origin = std::env::var("NOAH_TEST_EXPO_ORIGIN")
            .map_err(|_| ApiError::InvalidArgument("Local Expo origin required".to_string()))?;
        let url = local_expo_origin(&origin)?;
        return Ok(Expo::new_with_base_url(
            Some(access_token.to_owned()),
            url.as_str().trim_end_matches('/'),
        ));
    }
    Ok(Expo::new(ExpoClientOptions {
        access_token: Some(access_token.to_owned()),
    }))
}

#[derive(Debug)]
struct ResolvedUnifiedPushEndpoint {
    url: Url,
    host: String,
    addresses: Vec<SocketAddr>,
}

/// Determines if a push token is an Expo push token.
/// All other tokens (e.g., UnifiedPush HTTP endpoints) are treated as non-Expo.
fn is_expo_token(token: &str) -> bool {
    ((token.starts_with("ExponentPushToken[") || token.starts_with("ExpoPushToken["))
        && token.ends_with(']'))
        || regex::Regex::new(r"^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$")
            .expect("regex is valid")
            .is_match(token)
}

/// Validates a push token before it is persisted. Expo token formats are kept
/// unchanged; all other tokens must be public HTTPS UnifiedPush endpoints.
pub async fn validate_push_token(token: &str) -> Result<(), ApiError> {
    if is_expo_token(token) {
        return Ok(());
    }

    resolve_unified_push_endpoint(token)
        .await
        .map(|_| ())
        .map_err(|_| ApiError::InvalidArgument("Invalid push token".to_string()))
}

fn parse_unified_push_endpoint(endpoint: &str) -> Result<(Url, String, u16), ()> {
    if endpoint.len() > UNIFIED_PUSH_ENDPOINT_MAX_BYTES || endpoint_has_userinfo(endpoint) {
        return Err(());
    }

    let url = Url::parse(endpoint).map_err(|_| ())?;
    let local_http = integration_test_mode()
        && url.scheme() == "http"
        && url.host_str().is_some_and(loopback_host);
    if (url.scheme() != "https" && !local_http) || url.fragment().is_some() {
        return Err(());
    }

    if !url.username().is_empty() || url.password().is_some() {
        return Err(());
    }

    let host = url
        .host_str()
        .ok_or(())?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = url.port_or_known_default().ok_or(())?;
    if port == 0 {
        return Err(());
    }

    Ok((url, host, port))
}

fn endpoint_has_userinfo(endpoint: &str) -> bool {
    let Some((_, after_scheme)) = endpoint.split_once("://") else {
        return false;
    };
    let authority_end = after_scheme
        .find(|character| matches!(character, '/' | '?' | '#'))
        .unwrap_or(after_scheme.len());
    after_scheme[..authority_end].contains('@')
}

async fn resolve_unified_push_endpoint(endpoint: &str) -> Result<ResolvedUnifiedPushEndpoint, ()> {
    let (url, host, port) = parse_unified_push_endpoint(endpoint)?;
    let resolved = timeout(UNIFIED_PUSH_DNS_TIMEOUT, lookup_host((host.as_str(), port)))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let addresses = validate_resolved_addresses(resolved)?;

    Ok(ResolvedUnifiedPushEndpoint {
        url,
        host,
        addresses,
    })
}

fn validate_resolved_addresses(
    addresses: impl IntoIterator<Item = SocketAddr>,
) -> Result<Vec<SocketAddr>, ()> {
    let mut addresses: Vec<_> = addresses.into_iter().collect();
    addresses.sort_unstable();
    addresses.dedup();

    if addresses.is_empty()
        || addresses.iter().any(|address| {
            !is_public_ip(address.ip()) && !(integration_test_mode() && address.ip().is_loopback())
        })
    {
        return Err(());
    }

    Ok(addresses)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();

    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();

    // Global unicast currently occupies 2000::/3. Explicitly exclude special
    // allocations within it that are not suitable public delivery targets.
    (segments[0] & 0xe000) == 0x2000
        && !(segments[0] == 0x2001 && segments[1] <= 0x01ff)
        && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        && segments[0] != 0x2002
        && !(segments[0] == 0x3fff && (segments[1] & 0xf000) == 0)
}

fn notification_type_for_log(data: &str) -> String {
    serde_json::from_str::<serde_json::Value>(data)
        .ok()
        .and_then(|value| {
            value
                .get("notification_type")
                .and_then(|notification_type| notification_type.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown".to_string())
}

#[derive(Serialize, Clone, Debug)]
pub struct PushNotificationData {
    pub title: Option<String>,
    pub body: Option<String>,
    pub data: String,
    pub priority: Priority,
    // This is iOS only which makes the app wake up to do things
    pub content_available: bool,
}

#[derive(Debug, Clone)]
pub struct PushDispatchReceipt {
    pub pubkey: String,
    pub notification_k1: String,
}

#[derive(Debug, Clone)]
struct PushTarget {
    pubkey: String,
    push_token: String,
}

pub async fn send_push_notification(
    app_state: AppState,
    data: PushNotificationData,
    pubkey: Option<String>,
) -> anyhow::Result<(), ApiError> {
    send_push_notification_internal(app_state, data, pubkey, true).await
}

pub async fn send_expo_push_notification(
    app_state: AppState,
    data: PushNotificationData,
    pubkey: Option<String>,
) -> anyhow::Result<(), ApiError> {
    send_push_notification_internal(app_state, data, pubkey, false).await
}

pub async fn has_expo_push_token(app_state: &AppState, pubkey: &str) -> Result<bool, ApiError> {
    let push_token_repo = PushTokenRepository::new(&app_state.db_pool);
    let Some(push_token) = push_token_repo.find_by_pubkey(pubkey).await? else {
        return Ok(false);
    };

    Ok(is_expo_token(&push_token))
}

pub async fn send_push_notification_with_unique_k1(
    app_state: AppState,
    base_notification_data: NotificationRequestData,
    pubkey: Option<String>,
) -> anyhow::Result<Vec<PushDispatchReceipt>, ApiError> {
    // For notifications that need unique k1 per device, we don't use the batching approach
    // Instead, we send individual notifications with unique k1 values
    let expo = expo_client(&app_state.config.expo_access_token)?;

    let push_token_repo = PushTokenRepository::new(&app_state.db_pool);

    let push_targets = if let Some(pubkey) = pubkey {
        match push_token_repo.find_by_pubkey(&pubkey).await? {
            Some(push_token) => vec![PushTarget { pubkey, push_token }],
            None => vec![],
        }
    } else {
        push_token_repo
            .find_all_with_pubkeys()
            .await?
            .into_iter()
            .map(|(pubkey, push_token)| PushTarget { pubkey, push_token })
            .collect()
    };

    if push_targets.is_empty() {
        return Ok(vec![]);
    }

    // Send individual notifications with unique k1 for each device
    let receipts = stream::iter(push_targets)
        .filter_map(|target| {
            let expo_clone = expo.clone();
            let app_state_clone = app_state.clone();
            let base_data_clone = base_notification_data.clone();
            async move {
                // Create notification data with unique k1 if needed
                let notification_k1 = if base_data_clone.needs_unique_k1() {
                    match make_k1(&app_state_clone.k1_cache).await {
                        Ok(unique_k1) => Some(unique_k1),
                        Err(e) => {
                            tracing::error!(
                                "Failed to create unique k1 for push notification: {}",
                                e
                            );
                            return None;
                        }
                    }
                } else {
                    None
                };

                let notification_data = match base_data_clone
                    .into_notification_data(notification_k1.clone())
                {
                    Ok(notification_data) => notification_data,
                    Err(e) => {
                        tracing::error!("Failed to build notification payload: {}", e);
                        return None;
                    }
                };

                let data_string = match serde_json::to_string(&notification_data) {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::error!("Failed to serialize notification data: {}", e);
                        return None;
                    }
                };

                let send_result = if is_expo_token(&target.push_token) {
                    let push_data = PushNotificationData {
                        title: None,
                        body: None,
                        data: data_string,
                        priority: Priority::High,
                        content_available: true,
                    };

                    let message = match ExpoPushMessage::builder(vec![target.push_token.clone()])
                        .data(&push_data.data)
                        .and_then(|b| {
                            b.priority(push_data.priority)
                                .content_available(push_data.content_available)
                                .mutable_content(false)
                                .build()
                        }) {
                        Ok(msg) => msg,
                        Err(e) => {
                            tracing::error!("Failed to build push notification message: {}", e);
                            return None;
                        }
                    };

                    expo_clone
                        .send_push_notifications(message)
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                } else {
                    send_unified_notification(&target.push_token, &data_string)
                        .await
                        .map_err(|e| e.to_string())
                };

                if let Err(e) = send_result {
                    tracing::error!(pubkey = %target.pubkey, "Failed to send push notification: {}", e);
                    return None;
                }

                Some(PushDispatchReceipt {
                    pubkey: target.pubkey,
                    notification_k1: notification_k1.unwrap_or_default(),
                })
            }
        })
        .collect::<Vec<_>>()
        .await;

    tracing::debug!(
        "send_push_notification_with_unique_k1: Sent {} notifications with unique k1s {:?}",
        receipts.len(),
        base_notification_data
    );
    Ok(receipts)
}

async fn send_push_notification_internal(
    app_state: AppState,
    data: PushNotificationData,
    pubkey: Option<String>,
    allow_unified_push: bool,
) -> anyhow::Result<(), ApiError> {
    let expo = expo_client(&app_state.config.expo_access_token)?;

    let push_token_repo = PushTokenRepository::new(&app_state.db_pool);

    let push_tokens = if let Some(pubkey) = pubkey {
        // A single token might not be found, which is not an error, so we handle the Option.
        match push_token_repo.find_by_pubkey(&pubkey).await? {
            Some(token) => vec![token],
            None => vec![],
        }
    } else {
        push_token_repo.find_all().await?
    };
    let notification_type = notification_type_for_log(&data.data);

    if push_tokens.is_empty() {
        tracing::warn!(
            notification_type,
            "send_push_notification: no push tokens found for notification"
        );
        return Ok(());
    }

    tracing::info!(
        notification_type,
        "send_push_notification: Sending to {} tokens",
        push_tokens.len()
    );

    let (expo_tokens, unified_tokens): (Vec<_>, Vec<_>) =
        push_tokens.into_iter().partition(|t| is_expo_token(t));

    if !allow_unified_push {
        if !unified_tokens.is_empty() {
            tracing::info!(
                notification_type,
                skipped_unified_push_tokens = unified_tokens.len(),
                "send_push_notification: skipping UnifiedPush tokens for Expo-only notification"
            );
        }

        if expo_tokens.is_empty() {
            tracing::warn!(
                notification_type,
                "send_push_notification: no Expo push tokens found for Expo-only notification"
            );
            return Ok(());
        }
    }

    if !expo_tokens.is_empty() {
        let chunks = expo_tokens
            .chunks(100)
            .map(|c| c.to_vec())
            .collect::<Vec<_>>();

        stream::iter(chunks)
            .for_each_concurrent(None, |chunk| {
                let expo_clone = expo.clone();
                let data_clone = data.clone();
                async move {
                    let mut builder = ExpoPushMessage::builder(chunk);
                    if let Some(title) = &data_clone.title {
                        builder = builder.title(title.clone());
                    }
                    if let Some(body) = &data_clone.body {
                        builder = builder.body(body.clone());
                    }
                    let message = match builder.data(&data_clone.data).and_then(|b| {
                        b.priority(data_clone.priority)
                            .content_available(data_clone.content_available)
                            .mutable_content(false)
                            .build()
                    }) {
                        Ok(msg) => msg,
                        Err(e) => {
                            tracing::error!("Failed to build push notification message: {}", e);
                            return;
                        }
                    };

                    if let Err(e) = expo_clone.send_push_notifications(message).await {
                        tracing::error!("Failed to send push notification chunk: {}", e);
                    }
                }
            })
            .await;
    }

    if allow_unified_push && !unified_tokens.is_empty() {
        let data_clone = data.clone();
        stream::iter(unified_tokens)
            .for_each_concurrent(Some(UNIFIED_PUSH_CONCURRENCY_LIMIT), |endpoint| {
                let payload = data_clone.clone();
                async move {
                    if let Err(e) = send_unified_notification(&endpoint, &payload.data).await {
                        tracing::error!("Failed to send unified push notification: {}", e);
                    }
                }
            })
            .await;
    }

    tracing::info!(
        notification_type,
        "send_push_notification: Sent push notification"
    );

    Ok(())
}

async fn send_unified_notification(endpoint: &str, payload: &str) -> Result<(), ApiError> {
    // Resolve immediately before sending, then pin the request to that exact
    // public address set. This closes the DNS-rebinding gap between validation
    // and connection establishment while retaining TLS hostname verification.
    let resolved = resolve_unified_push_endpoint(endpoint)
        .await
        .map_err(|_| ApiError::ServerErr("Invalid UnifiedPush endpoint".to_string()))?;
    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(UNIFIED_PUSH_CONNECT_TIMEOUT)
        .timeout(UNIFIED_PUSH_REQUEST_TIMEOUT)
        .resolve_to_addrs(&resolved.host, &resolved.addresses)
        .build()
        .map_err(|_| {
            ApiError::ServerErr("Failed to initialize UnifiedPush delivery".to_string())
        })?;

    let response = client
        .post(resolved.url)
        .body(payload.to_string())
        .send()
        .await
        .map_err(|_| ApiError::ServerErr("Failed to send push notification".to_string()))?;

    if !response.status().is_success() {
        return Err(ApiError::ServerErr(
            "UnifiedPush endpoint returned a non-success status".to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_expo_origin_is_literal_loopback_only() {
        assert!(local_expo_origin("http://127.0.0.1:39123").is_ok());
        assert!(local_expo_origin("http://[::1]:39123").is_ok());
        for origin in [
            "http://localhost:39123",
            "http://10.0.0.1:39123",
            "https://127.0.0.1:39123",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://user@127.0.0.1:39123",
            "http://127.0.0.1:39123/path",
            "http://127.0.0.1:39123?key=value",
            "http://127.0.0.1:39123#fragment",
        ] {
            assert!(local_expo_origin(origin).is_err(), "{origin}");
        }
    }

    #[tokio::test]
    #[ignore = "isolated harness sets test mode and a reserved loopback origin"]
    async fn local_push_transports_deliver_real_requests() {
        use axum::{Json, Router, extract::State, routing::post};
        use serde_json::{Value, json};
        use std::sync::{Arc, Mutex};

        assert!(integration_test_mode());
        let origin = local_expo_origin(&std::env::var("NOAH_TEST_EXPO_ORIGIN").unwrap()).unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", origin.port().unwrap()))
            .await
            .unwrap();
        let received = Arc::new(Mutex::new(Vec::<Value>::new()));
        let app = Router::new()
            .route("/--/api/v2/push/send", post(|State(received): State<Arc<Mutex<Vec<Value>>>>,
                Json(body): Json<Value>| async move {
                received.lock().unwrap().push(body);
                Json(json!({"data":[{"status":"ok","id":"00000000-0000-4000-8000-000000000001"}]}))
            }))
            .route("/phone", post(|State(received): State<Arc<Mutex<Vec<Value>>>>,
                body: String| async move {
                received.lock().unwrap().push(serde_json::from_str(&body).unwrap());
                axum::http::StatusCode::NO_CONTENT
            }))
            .route("/redirect", post(|| async {axum::response::Redirect::temporary("/phone")}))
            .with_state(received.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let payload = json!({"notification_type":"maintenance","round_seq":7});
        let message = ExpoPushMessage::builder(["ExpoPushToken[local-phone]"])
            .data(&payload)
            .unwrap()
            .build()
            .unwrap();
        let tickets = timeout(
            Duration::from_secs(5),
            expo_client("local-fixture")
                .unwrap()
                .send_push_notifications(message),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(tickets.len(), 1);
        let destination = format!("{}/phone", origin.as_str().trim_end_matches('/'));
        validate_push_token(&destination).await.unwrap();
        send_unified_notification(&destination, &payload.to_string())
            .await
            .unwrap();
        let redirect = format!("{}/redirect", origin.as_str().trim_end_matches('/'));
        assert!(
            send_unified_notification(&redirect, &payload.to_string())
                .await
                .is_err()
        );
        let requests = received.lock().unwrap();
        assert_eq!(
            requests.len(),
            2,
            "redirect must not dispatch a second phone request"
        );
        // The pinned Expo client serializes a one-message chunk as an object.
        assert_eq!(requests[0]["to"], json!(["ExpoPushToken[local-phone]"]));
        assert_eq!(requests[0]["data"], payload);
        assert_eq!(requests[1], payload);
        drop(requests);
        server.abort();
        let _ = server.await;
    }

    #[test]
    fn expo_token_formats_are_preserved() {
        assert!(is_expo_token("ExponentPushToken[test-token]"));
        assert!(is_expo_token("ExpoPushToken[test-token]"));
        assert!(is_expo_token("123e4567-e89b-12d3-a456-426614174000"));
    }

    #[test]
    fn unified_push_url_rules_are_enforced() {
        assert!(
            parse_unified_push_endpoint("https://push.example.com:8443/up/topic?key=value").is_ok()
        );
        assert!(parse_unified_push_endpoint("http://push.example.com/up/topic").is_err());
        assert!(parse_unified_push_endpoint("https://user@push.example.com/up/topic").is_err());
        assert!(parse_unified_push_endpoint("https://push.example.com/up/topic#fragment").is_err());
        assert!(parse_unified_push_endpoint("https://push.example.com:0/up/topic").is_err());
        let (_, ipv6_host, ipv6_port) =
            parse_unified_push_endpoint("https://[2606:4700:4700::1111]:8443/up/topic").unwrap();
        assert_eq!(ipv6_host, "2606:4700:4700::1111");
        assert_eq!(ipv6_port, 8443);
        assert!(
            parse_unified_push_endpoint(&format!(
                "https://push.example.com/{}",
                "a".repeat(UNIFIED_PUSH_ENDPOINT_MAX_BYTES)
            ))
            .is_err()
        );
    }

    #[test]
    fn only_public_ipv4_addresses_are_allowed() {
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.0.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }

        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn only_public_ipv6_addresses_are_allowed() {
        for address in [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::127.0.0.1",
            "100::1",
            "2001:db8::1",
            "2002::1",
            "3fff::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }

        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn mixed_or_empty_dns_results_are_rejected() {
        assert!(validate_resolved_addresses([]).is_err());
        assert!(
            validate_resolved_addresses([
                "1.1.1.1:443".parse().unwrap(),
                "127.0.0.1:443".parse().unwrap(),
            ])
            .is_err()
        );
        assert_eq!(
            validate_resolved_addresses([
                "1.1.1.1:443".parse().unwrap(),
                "1.1.1.1:443".parse().unwrap(),
            ])
            .unwrap(),
            vec!["1.1.1.1:443".parse().unwrap()]
        );
    }

    #[tokio::test]
    async fn public_ip_endpoint_resolves_without_external_dns() {
        validate_push_token("https://1.1.1.1:8443/up/topic?key=value")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn private_ip_endpoint_is_rejected() {
        assert!(
            validate_push_token("https://127.0.0.1/up/topic")
                .await
                .is_err()
        );
    }
}
