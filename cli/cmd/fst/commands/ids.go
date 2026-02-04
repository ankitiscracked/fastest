package commands

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

func generateSnapshotID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("snap-%d", time.Now().UnixNano())
	}
	return "snap-" + hex.EncodeToString(bytes)
}

func shortenIDs(ids []string, minLen int) map[string]string {
	result := make(map[string]string, len(ids))
	if minLen < 1 {
		minLen = 1
	}
	for _, id := range ids {
		if id == "" {
			continue
		}
		targetLen := minLen
		if targetLen > len(id) {
			targetLen = len(id)
		}
		chosen := id
		for l := targetLen; l <= len(id); l++ {
			prefix := id[:l]
			unique := true
			for _, other := range ids {
				if other == id {
					continue
				}
				if strings.HasPrefix(other, prefix) {
					unique = false
					break
				}
			}
			if unique {
				chosen = prefix
				break
			}
		}
		result[id] = chosen
	}
	return result
}

func resolveIDPrefix(input string, ids []string, label string) (string, error) {
	if input == "" {
		return "", fmt.Errorf("%s ID is required", label)
	}
	matches := make([]string, 0, 4)
	for _, id := range ids {
		if strings.HasPrefix(id, input) {
			matches = append(matches, id)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("%s %q not found", label, input)
	}
	sort.Strings(matches)
	return "", fmt.Errorf("%s %q is ambiguous: %s", label, input, strings.Join(matches, ", "))
}
