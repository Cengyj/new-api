package service

import waffonet "github.com/waffo-com/waffo-go/net"

// WaffoHTTPTransport permits isolated transport-boundary verification while
// retaining the SDK's request signing, response verification and decoding.
// Nil uses the SDK's default TLS transport and timeouts.
var WaffoHTTPTransport waffonet.HttpTransport
