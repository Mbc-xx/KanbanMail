//! Sign-in with a browser (OAuth 2, authorization code with PKCE) for the mailboxes
//! that do not take a password: Microsoft 365 and Outlook.com, and Google as an
//! alternative to app passwords.
//!
//! The sign-in happens in the system browser, never in the app, and comes back on a
//! port of this computer. Only the refresh token is kept, in the system keychain;
//! access tokens last about an hour, stay in memory and are renewed when connecting.
//!
//! The application ids are chosen when building (see the README): without one, that
//! sign-in is not offered.

use crate::account::{Account, Provider};
use crate::secret;
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

/// Part of the error shown when the sign-in stopped working: the UI recognises it to
/// offer the sign-in again. It must not look like a network error.
pub const SIGN_IN_AGAIN: &str = "Sign in again";

/// How long the browser sign-in may take.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Renew an access token this long before it expires.
const EXPIRY_MARGIN: Duration = Duration::from_secs(120);
/// `tid` of the personal Microsoft accounts (Outlook.com and the like).
const MICROSOFT_PERSONAL_TENANT: &str = "9188040d-6c67-4c5b-b112-36a304b66dad";

/// One sign-in service, as registered by whoever builds the app.
#[derive(Debug, Clone)]
struct Client {
    auth_url: String,
    token_url: String,
    scopes: &'static str,
    client_id: String,
    /// Google requires it for desktop apps, while saying it is not really secret.
    client_secret: Option<String>,
    /// Google accepts only an address, Microsoft registers `localhost`.
    redirect_host: &'static str,
    extra_params: &'static [(&'static str, &'static str)],
}

fn client(provider: Provider) -> Option<Client> {
    let filled = |value: Option<&'static str>| value.map(str::trim).filter(|v| !v.is_empty()).map(String::from);
    match provider {
        Provider::Microsoft => Some(Client {
            auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize".into(),
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token".into(),
            scopes: "openid email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
            client_id: filled(option_env!("KANBANMAIL_MICROSOFT_CLIENT_ID"))?,
            client_secret: None,
            redirect_host: "localhost",
            extra_params: &[("prompt", "select_account")],
        }),
        Provider::Gmail => Some(Client {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            scopes: "openid email https://mail.google.com/",
            client_id: filled(option_env!("KANBANMAIL_GOOGLE_CLIENT_ID"))?,
            client_secret: filled(option_env!("KANBANMAIL_GOOGLE_CLIENT_SECRET")),
            redirect_host: "127.0.0.1",
            // A refresh token comes only with these two.
            extra_params: &[("access_type", "offline"), ("prompt", "consent")],
        }),
        Provider::Other | Provider::Icloud => None,
    }
}

/// The services this build can sign in to.
pub fn available() -> Vec<Provider> {
    [Provider::Microsoft, Provider::Gmail].into_iter().filter(|p| client(*p).is_some()).collect()
}

/// A completed sign-in.
#[derive(Debug, Clone)]
pub struct SignedIn {
    /// Address of the signed-in user, as the service reports it.
    pub email: String,
    pub refresh_token: String,
    /// A personal Microsoft account, which sends through another SMTP server.
    pub personal: bool,
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    id_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize, Default)]
struct Identity {
    email: Option<String>,
    preferred_username: Option<String>,
    tid: Option<String>,
}

/// What the ID token says about the user. It comes straight from the service over
/// TLS, so its signature needs no check (OpenID Connect Core, 3.1.3.7).
fn identity(id_token: &str) -> Result<Identity> {
    let payload = id_token.split('.').nth(1).context("invalid ID token")?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).context("invalid ID token")?;
    serde_json::from_slice(&bytes).context("invalid ID token")
}

fn random_text() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| anyhow!("no random numbers: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorize_url(client: &Client, redirect: &str, state: &str, verifier: &str, hint: &str) -> Result<String> {
    let mut params = vec![
        ("client_id", client.client_id.as_str()),
        ("response_type", "code"),
        ("redirect_uri", redirect),
        ("scope", client.scopes),
        ("state", state),
    ];
    let code_challenge = challenge(verifier);
    params.push(("code_challenge", &code_challenge));
    params.push(("code_challenge_method", "S256"));
    params.extend(client.extra_params.iter().copied());
    if !hint.is_empty() {
        params.push(("login_hint", hint));
    }
    Ok(url::Url::parse_with_params(&client.auth_url, &params)?.to_string())
}

/// What the browser brought back on the local port.
#[derive(Debug, PartialEq)]
enum Redirect {
    Code(String),
    Refused(String),
    /// Not for us (a favicon, a page opened by something else): keep waiting.
    Ignored,
}

/// Reads the first line of a request, like `GET /?code=abc&state=xyz HTTP/1.1`.
fn parse_redirect(request_line: &str, state: &str) -> Redirect {
    let target = request_line.split_whitespace().nth(1).unwrap_or_default();
    let Some((path, query)) = target.split_once('?') else { return Redirect::Ignored };
    if path != "/" {
        return Redirect::Ignored;
    }
    let params: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    // Anything else on this computer could call the port: without our state it counts for nothing.
    if params.get("state").map(String::as_str) != Some(state) {
        return Redirect::Ignored;
    }
    if let Some(code) = params.get("code") {
        return Redirect::Code(code.clone());
    }
    let why = params.get("error_description").or(params.get("error")).cloned().unwrap_or_default();
    Redirect::Refused(why)
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>Pigeonhole</title>\
<body style=\"font:16px system-ui;text-align:center;margin-top:20vh\">\
<h2>You can close this page</h2><p>Go back to Pigeonhole.</p>";

async fn answer(stream: &mut TcpStream, status: &str, body: &str) {
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(reply.as_bytes()).await.ok();
    stream.shutdown().await.ok();
}

/// Waits for the browser on the local port(s) and returns the code it brings.
async fn wait_for_code(v4: TcpListener, v6: Option<TcpListener>, state: &str) -> Result<String> {
    loop {
        let accepted = match &v6 {
            Some(v6) => tokio::select! { a = v4.accept() => a, a = v6.accept() => a },
            None => v4.accept().await,
        };
        let Ok((mut stream, _)) = accepted else { continue };
        let mut buffer = vec![0u8; 8192];
        let mut read = 0;
        // A browser can open a connection and send nothing on it.
        while !buffer[..read].windows(2).any(|w| w == b"\r\n") && read < buffer.len() {
            match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer[read..])).await {
                Ok(Ok(n)) if n > 0 => read += n,
                _ => break,
            }
        }
        let text = String::from_utf8_lossy(&buffer[..read]);
        match parse_redirect(text.lines().next().unwrap_or_default(), state) {
            Redirect::Code(code) => {
                answer(&mut stream, "200 OK", PAGE).await;
                return Ok(code);
            }
            Redirect::Refused(why) => {
                answer(&mut stream, "200 OK", PAGE).await;
                bail!("the sign-in was refused: {why}");
            }
            Redirect::Ignored => answer(&mut stream, "404 Not Found", "").await,
        }
    }
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(crate::imap::tls_config())
        .timeout(Duration::from_secs(30))
        .build()
        .context("cannot set up HTTPS")
}

/// Sends a request to the token service. A refused request comes back as `Ok` with
/// `error` set; `Err` means the service could not be reached.
async fn token_request(client: &Client, form: &[(&str, &str)]) -> Result<TokenReply> {
    let mut fields = form.to_vec();
    fields.push(("client_id", &client.client_id));
    if let Some(secret) = &client.client_secret {
        fields.push(("client_secret", secret));
    }
    let reply = http()?
        .post(&client.token_url)
        .form(&fields)
        .send()
        .await
        .map_err(|_| anyhow!("cannot reach the sign-in service"))?;
    let bytes = reply.bytes().await.map_err(|_| anyhow!("cannot reach the sign-in service"))?;
    serde_json::from_slice(&bytes).context("unexpected answer from the sign-in service")
}

/// Signs in with the system browser. `open` shows the page; the future can be dropped to cancel.
pub async fn sign_in(provider: Provider, hint: &str, open: impl FnOnce(&str) -> Result<(), String>) -> Result<SignedIn> {
    let client = client(provider).context("this build has no sign-in for this service")?;
    let v4 = TcpListener::bind(("127.0.0.1", 0)).await.context("cannot open a local port for the sign-in")?;
    let port = v4.local_addr()?.port();
    // `localhost` may mean the IPv6 address in the browser.
    let v6 = TcpListener::bind(("::1", port)).await.ok();
    let redirect = format!("http://{}:{port}/", client.redirect_host);
    let (state, verifier) = (random_text()?, random_text()?);
    open(&authorize_url(&client, &redirect, &state, &verifier, hint)?).map_err(|e| anyhow!(e))?;

    let code = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_code(v4, v6, &state))
        .await
        .map_err(|_| anyhow!("the sign-in took too long, try again"))??;
    let form = [
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &redirect),
        ("code_verifier", &verifier),
    ];
    let reply = token_request(&client, &form).await?;
    let (Some(access), Some(refresh)) = (reply.access_token, reply.refresh_token) else {
        bail!("the sign-in failed: {}", reply.error_description.or(reply.error).unwrap_or_default());
    };
    let who = reply.id_token.as_deref().map(identity).transpose()?.unwrap_or_default();
    let email = who.email.filter(|e| !e.is_empty()).or(who.preferred_username).unwrap_or_default();
    remember(&email, access.clone(), reply.expires_in).await;
    if !hint.is_empty() {
        remember(hint, access, reply.expires_in).await;
    }
    let personal = who.tid.as_deref() == Some(MICROSOFT_PERSONAL_TENANT);
    Ok(SignedIn { email, refresh_token: refresh, personal })
}

struct Token {
    value: String,
    expires: Instant,
}

/// Access tokens by address. Held during a renewal, so that two connections
/// starting together do not both spend a refresh token that may work only once.
fn tokens() -> &'static Mutex<HashMap<String, Token>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, Token>>> = OnceLock::new();
    TOKENS.get_or_init(Default::default)
}

fn key(email: &str) -> String {
    email.trim().to_lowercase()
}

fn valid_until(expires_in: Option<u64>) -> Instant {
    Instant::now() + Duration::from_secs(expires_in.unwrap_or(3600)).saturating_sub(EXPIRY_MARGIN)
}

async fn remember(email: &str, value: String, expires_in: Option<u64>) {
    tokens().lock().await.insert(key(email), Token { value, expires: valid_until(expires_in) });
}

/// Drops the access token, after a server refused it.
pub async fn forget(email: &str) {
    tokens().lock().await.remove(&key(email));
}

/// Was the refresh token refused for good (revoked, expired, password changed)?
fn must_sign_in_again(error: &str) -> bool {
    matches!(error, "invalid_grant" | "interaction_required" | "consent_required" | "login_required")
}

/// A valid access token for the account, renewed if needed.
pub async fn access_token(account: &Account) -> Result<String> {
    let mut all = tokens().lock().await;
    if let Some(token) = all.get(&key(&account.email)).filter(|t| t.expires > Instant::now()) {
        return Ok(token.value.clone());
    }
    let expired = || anyhow!("Your sign-in to {} has expired. {SIGN_IN_AGAIN}.", account.email);
    let client = client(account.provider()).context("this build has no sign-in for this service")?;
    let refresh = secret::get_refresh_token(&account.email)?.ok_or_else(expired)?;
    let reply = token_request(&client, &[("grant_type", "refresh_token"), ("refresh_token", &refresh)]).await?;
    if let Some(error) = &reply.error {
        if must_sign_in_again(error) {
            return Err(expired());
        }
        bail!("the sign-in service refused: {}", reply.error_description.as_deref().unwrap_or(error));
    }
    let value = reply.access_token.context("no access token from the sign-in service")?;
    // Microsoft replaces the refresh token, Google keeps the old one.
    if let Some(new) = reply.refresh_token.filter(|r| *r != refresh) {
        secret::set_refresh_token(&account.email, &new)?;
    }
    all.insert(key(&account.email), Token { value: value.clone(), expires: valid_until(reply.expires_in) });
    Ok(value)
}

/// The SASL XOAUTH2 message, without its base64 (used by IMAP; lettre builds its own).
pub fn xoauth2(user: &str, token: &str) -> String {
    format!("user={user}\x01auth=Bearer {token}\x01\x01")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_client() -> Client {
        Client {
            auth_url: "https://login.example.com/authorize".into(),
            token_url: "https://login.example.com/token".into(),
            scopes: "openid email",
            client_id: "app".into(),
            client_secret: None,
            redirect_host: "localhost",
            extra_params: &[("prompt", "select_account")],
        }
    }

    #[test]
    fn pkce_matches_the_rfc_example() {
        // RFC 7636, appendix B.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn random_texts_differ_and_fit_pkce() {
        let (a, b) = (random_text().unwrap(), random_text().unwrap());
        assert_ne!(a, b);
        assert!((43..=128).contains(&a.len()));
    }

    #[test]
    fn the_authorize_url_carries_everything() {
        let url = authorize_url(&test_client(), "http://localhost:5000/", "st", "ver", "a@example.com").unwrap();
        let url = url::Url::parse(&url).unwrap();
        let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["redirect_uri"], "http://localhost:5000/");
        assert_eq!(q["code_challenge"], challenge("ver"));
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["login_hint"], "a@example.com");
        assert_eq!(q["prompt"], "select_account");
    }

    #[test]
    fn redirects_are_trusted_only_with_our_state() {
        let code = parse_redirect("GET /?code=a%2Fb&state=st HTTP/1.1", "st");
        assert_eq!(code, Redirect::Code("a/b".into()));
        assert_eq!(parse_redirect("GET /?code=a&state=other HTTP/1.1", "st"), Redirect::Ignored);
        assert_eq!(parse_redirect("GET /?code=a HTTP/1.1", "st"), Redirect::Ignored);
        assert_eq!(parse_redirect("GET /favicon.ico HTTP/1.1", "st"), Redirect::Ignored);
        assert_eq!(parse_redirect("GET /other?code=a&state=st HTTP/1.1", "st"), Redirect::Ignored);
        let refused = parse_redirect("GET /?error=access_denied&error_description=No+way&state=st HTTP/1.1", "st");
        assert_eq!(refused, Redirect::Refused("No way".into()));
    }

    #[tokio::test]
    async fn the_browser_comes_back_with_the_code() {
        let v4 = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = v4.local_addr().unwrap().port();
        let browser = tokio::spawn(async move {
            for line in ["GET /favicon.ico HTTP/1.1\r\n\r\n", "GET /?code=good&state=st HTTP/1.1\r\n\r\n"] {
                let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                s.write_all(line.as_bytes()).await.unwrap();
                let mut reply = String::new();
                s.read_to_string(&mut reply).await.unwrap();
                assert!(reply.starts_with("HTTP/1.1"));
            }
        });
        assert_eq!(wait_for_code(v4, None, "st").await.unwrap(), "good");
        browser.await.unwrap();
    }

    #[test]
    fn the_id_token_gives_the_user() {
        let body = URL_SAFE_NO_PAD.encode(r#"{"preferred_username":"a@contoso.com","tid":"x"}"#);
        let who = identity(&format!("head.{body}.sign")).unwrap();
        assert_eq!(who.preferred_username.as_deref(), Some("a@contoso.com"));
        assert!(identity("nonsense").is_err());
    }

    /// Answers one HTTP request with `body` and returns what it received.
    async fn one_reply(listener: TcpListener, body: &'static str) -> String {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let n = s.read(&mut buffer).await.unwrap();
            request.extend_from_slice(&buffer[..n]);
            let text = String::from_utf8_lossy(&request);
            let Some((head, rest)) = text.split_once("\r\n\r\n") else { continue };
            let length = head
                .lines()
                .find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse::<usize>().unwrap()))
                .unwrap_or(0);
            if rest.len() >= length {
                break;
            }
        }
        let reply = format!("HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        s.write_all(reply.as_bytes()).await.unwrap();
        String::from_utf8_lossy(&request).to_string()
    }

    #[tokio::test]
    async fn a_refusal_of_the_token_service_is_an_answer_not_a_failure() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(one_reply(listener, r#"{"error":"invalid_grant","error_description":"gone"}"#));
        let mut client = test_client();
        client.token_url = format!("http://127.0.0.1:{port}/token");
        client.client_secret = Some("shh".into());
        let reply = token_request(&client, &[("grant_type", "refresh_token"), ("refresh_token", "r/1")]).await.unwrap();
        assert_eq!(reply.error.as_deref(), Some("invalid_grant"));
        let request = server.await.unwrap();
        assert!(request.contains("grant_type=refresh_token") && request.contains("refresh_token=r%2F1"));
        assert!(request.contains("client_id=app") && request.contains("client_secret=shh"));
    }

    #[tokio::test]
    async fn an_unreachable_service_reads_as_being_offline() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut client = test_client();
        client.token_url = format!("http://127.0.0.1:{port}/token");
        let e = token_request(&client, &[("grant_type", "refresh_token")]).await.err().unwrap();
        assert!(e.to_string().contains("cannot reach"));
    }

    /// Talks to the real services with made-up data: run by hand with `--ignored`.
    #[tokio::test]
    #[ignore]
    async fn the_real_token_services_answer() {
        for (url, id) in [
            ("https://login.microsoftonline.com/common/oauth2/v2.0/token", "00000000-0000-0000-0000-000000000000"),
            ("https://oauth2.googleapis.com/token", "invalid.apps.googleusercontent.com"),
        ] {
            let mut client = test_client();
            client.token_url = url.into();
            client.client_id = id.into();
            let reply = token_request(&client, &[("grant_type", "refresh_token"), ("refresh_token", "made-up")]).await.unwrap();
            println!("{url}: {:?}", reply.error);
            assert!(reply.error.is_some());
        }
    }

    #[test]
    fn xoauth2_has_the_expected_shape() {
        assert_eq!(xoauth2("a@b.c", "tok"), "user=a@b.c\x01auth=Bearer tok\x01\x01");
    }

    #[test]
    fn only_final_refusals_ask_for_a_new_sign_in() {
        assert!(must_sign_in_again("invalid_grant"));
        assert!(!must_sign_in_again("temporarily_unavailable"));
    }

    #[test]
    fn the_expired_message_does_not_look_like_being_offline() {
        // main.rs treats errors with these words as "no network" and would not ask to sign in.
        let text = format!("Your sign-in to a@b.c has expired. {SIGN_IN_AGAIN}.").to_lowercase();
        assert!(!["connection", "network", "offline", "cannot reach"].iter().any(|k| text.contains(k)));
    }
}
