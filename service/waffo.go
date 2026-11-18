package service

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"time"

	waffonet "github.com/waffo-com/waffo-go/net"
)

// WaffoHTTPTransport permits isolated transport-boundary verification while
// retaining the SDK's request signing, response verification and decoding.
// Nil uses the fixed-endpoint transport below with the SDK's TLS and timeouts.
var WaffoHTTPTransport waffonet.HttpTransport

type waffoHTTPTransport struct {
	client *http.Client
}

// NewWaffoHTTPTransport keeps merchant credentials and signed POST bodies on
// their original API endpoint. SDK v1.3.2 follows redirects internally before
// the host can inspect status codes, and does not expose its HTTP client.
func NewWaffoHTTPTransport(connectTimeout, readTimeout int64) *waffoHTTPTransport {
	if connectTimeout <= 0 {
		connectTimeout = waffonet.DefaultConnectTimeout
	}
	if readTimeout <= 0 {
		readTimeout = waffonet.DefaultReadTimeout
	}
	return &waffoHTTPTransport{client: &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
			DialContext: (&net.Dialer{
				Timeout: time.Duration(connectTimeout) * time.Millisecond, KeepAlive: 30 * time.Second,
			}).DialContext,
			MaxIdleConns: 100, IdleConnTimeout: 90 * time.Second,
			TLSHandshakeTimeout: 10 * time.Second, ExpectContinueTimeout: time.Second,
		},
		Timeout: time.Duration(readTimeout) * time.Millisecond,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}}
}

func (transport *waffoHTTPTransport) Send(ctx context.Context, request *waffonet.HttpRequest) (*waffonet.HttpResponse, error) {
	httpRequest, err := http.NewRequestWithContext(ctx, request.Method, request.URL, bytes.NewReader(request.Body))
	if err != nil {
		return nil, err
	}
	for key, value := range request.Headers {
		httpRequest.Header.Set(key, value)
	}
	client := transport.client
	if request.ConnectTimeout > 0 || request.ReadTimeout > 0 {
		// Match SDK request overrides, including its defaults for an omitted
		// timeout, without changing the redirect boundary for that request.
		override := NewWaffoHTTPTransport(request.ConnectTimeout, request.ReadTimeout)
		client = override.client
		defer client.CloseIdleConnections()
	}
	response, err := client.Do(httpRequest)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	headers := make(map[string]string, len(response.Header))
	for key := range response.Header {
		headers[key] = response.Header.Get(key)
	}
	return waffonet.NewHttpResponse(response.StatusCode, headers, body), nil
}
