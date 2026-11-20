package common

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/constant"
)

// ValidateHTTPEndpoint checks the scheme, host and port of a parsed URL.
func ValidateHTTPEndpoint(u *url.URL) error {
	if u == nil || (u.Scheme != "https" && u.Scheme != "http") {
		return errors.New("invalid URL scheme: only http and https are allowed")
	}
	if u.Hostname() == "" {
		return errors.New("URL must include a host")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.ParseUint(port, 10, 16)
		if err != nil || n == 0 {
			return errors.New("URL port must be between 1 and 65535")
		}
	}
	return nil
}

// ParseHTTPEndpoint returns a validated URL without including its contents in errors.
func ParseHTTPEndpoint(rawURL string) (*url.URL, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, errors.New("invalid URL format")
	}
	if err := ValidateHTTPEndpoint(u); err != nil {
		return nil, err
	}
	return u, nil
}

// ValidateRedirectURL validates that a redirect URL is safe to use.
// It checks that:
//   - The URL is properly formatted
//   - The scheme is either http or https
//   - The domain is in the trusted domains list (exact match or subdomain)
//
// Returns nil if the URL is valid and trusted, otherwise returns an error
// describing why the validation failed.
func ValidateRedirectURL(rawURL string) error {
	parsedURL, err := ParseHTTPEndpoint(rawURL)
	if err != nil {
		return err
	}

	domain := strings.ToLower(parsedURL.Hostname())

	for _, trustedDomain := range constant.TrustedRedirectDomains {
		if domain == trustedDomain || strings.HasSuffix(domain, "."+trustedDomain) {
			return nil
		}
	}

	return fmt.Errorf("domain %s is not in the trusted domains list", domain)
}
