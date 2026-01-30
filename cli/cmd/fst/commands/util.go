package commands

import "crypto/rand"

func randomSuffix(length int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz"
	if length <= 0 {
		return ""
	}

	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "rand"
	}
	for i := range bytes {
		bytes[i] = letters[int(bytes[i])%len(letters)]
	}
	return string(bytes)
}
