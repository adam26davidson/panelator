//! The relay domain. Today it holds the WebSocket relay stub of spec 111: test equipment for the
//! runtime spike. Nothing it sends or accepts is the relay protocol.

pub mod app;
pub mod cbor;
pub mod certs;
mod cli;
mod connection;
pub mod events;
pub mod server;
pub mod tls;
mod traffic;
