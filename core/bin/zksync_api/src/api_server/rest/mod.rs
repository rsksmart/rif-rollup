use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer};
use futures::channel::mpsc;
use std::net::SocketAddr;

use zksync_storage::ConnectionPool;
use zksync_types::H160;

use zksync_utils::panic_notify::ThreadPanicNotify;

use self::v01::api_decl::ApiV01;
use crate::{fee_ticker::TickerRequest, signature_checker::VerifySignatureRequest};

use super::tx_sender::TxSender;
use zksync_config::ZkSyncConfig;

use openssl::ssl::{SslAcceptor, SslFiletype, SslMethod};

mod forced_exit_requests;
mod helpers;
mod v01;
pub mod v02;

async fn start_server(
    api_v01: ApiV01,
    fee_ticker: mpsc::Sender<TickerRequest>,
    sign_verifier: mpsc::Sender<VerifySignatureRequest>,
    bind_to: SocketAddr,
    use_https: bool,
) {
    let server = HttpServer::new(move || {
        let api_v01 = api_v01.clone();

        let forced_exit_requests_api_scope =
            forced_exit_requests::api_scope(api_v01.connection_pool.clone(), &api_v01.config);

        let api_v02_scope = {
            let tx_sender = TxSender::new(
                api_v01.connection_pool.clone(),
                sign_verifier.clone(),
                fee_ticker.clone(),
                &api_v01.config,
            );
            v02::api_scope(tx_sender, &api_v01.config)
        };
        App::new()
            .wrap(
                Cors::default()
                    .send_wildcard()
                    .max_age(3600)
                    .allow_any_origin()
                    .allow_any_header()
                    .allow_any_method(),
            )
            .service(api_v01.into_scope())
            .service(forced_exit_requests_api_scope)
            .service(api_v02_scope)
            // Endpoint needed for js isReachable
            .route(
                "/favicon.ico",
                web::get().to(|| HttpResponse::Ok().finish()),
            )
    });

    // load ssl keys
    if use_https {
        // following example in https://github.com/actix/examples/blob/master/security/openssl/src/main.rs
        // and https://actix.rs/docs/http2/ (similar)
        // to create a self-signed temporary cert for testing:
        // `openssl req -x509 -newkey rsa:4096 -nodes -keyout key.pem -out cert.pem -days 365 -subj '/CN=localhost'`
        let mut builder = SslAcceptor::mozilla_intermediate(SslMethod::tls()).unwrap();
        builder
            .set_private_key_file("key.pem", SslFiletype::PEM)
            .unwrap();
        builder.set_certificate_chain_file("cert.pem").unwrap();

        server
            .workers(super::THREADS_PER_SERVER)
            .bind_openssl(bind_to, builder)
            .unwrap()
            .shutdown_timeout(1)
            .run()
            .await
            .expect("REST API server has crashed");
    } else {
        server
            .workers(super::THREADS_PER_SERVER)
            .bind(bind_to)
            .unwrap()
            .shutdown_timeout(1)
            .run()
            .await
            .expect("REST API server has crashed");
    }
}

/// Start HTTP REST API
#[allow(clippy::too_many_arguments)]
pub(super) fn start_server_thread_detached(
    connection_pool: ConnectionPool,
    listen_addr: SocketAddr,
    contract_address: H160,
    panic_notify: mpsc::Sender<bool>,
    fee_ticker: mpsc::Sender<TickerRequest>,
    sign_verifier: mpsc::Sender<VerifySignatureRequest>,
    config: ZkSyncConfig,
) {
    std::thread::Builder::new()
        .name("actix-rest-api".to_string())
        .spawn(move || {
            let _panic_sentinel = ThreadPanicNotify(panic_notify.clone());

            actix_rt::System::new().block_on(async move {
                let api_v01 = ApiV01::new(connection_pool, contract_address, config.clone());
                api_v01.spawn_network_status_updater(panic_notify);

                start_server(
                    api_v01,
                    fee_ticker,
                    sign_verifier,
                    listen_addr,
                    config.api.rest.use_https,
                )
                .await;
            });
        })
        .expect("Api server thread");
}
