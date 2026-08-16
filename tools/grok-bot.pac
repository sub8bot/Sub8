function FindProxyForURL(url, host) {
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return "DIRECT";
  }
  return "PROXY 127.0.0.1:8899";
}
