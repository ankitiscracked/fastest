package commands

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

func generateSnapshotID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("snap-%d", time.Now().UnixNano())
	}
	return "snap-" + hex.EncodeToString(bytes)
}
