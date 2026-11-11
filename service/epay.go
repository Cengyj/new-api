package service

import (
	"strings"

	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
)

func GetCallbackAddress() string {
	address := operation_setting.CustomCallbackAddress
	if address == "" {
		address = system_setting.ServerAddress
	}
	return strings.TrimRight(address, "/")
}
