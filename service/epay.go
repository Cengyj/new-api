package service

import (
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
)

func GetCallbackAddress() string {
	common.OptionMapRWMutex.RLock()
	address := operation_setting.CustomCallbackAddress
	if address == "" {
		address = system_setting.ServerAddress
	}
	common.OptionMapRWMutex.RUnlock()
	return strings.TrimRight(address, "/")
}
