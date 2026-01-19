-- User API keys for model providers
CREATE TABLE `user_api_keys` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `provider` text NOT NULL,
  `key_name` text NOT NULL,
  `key_value` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

-- Unique constraint: one key per provider per user
CREATE UNIQUE INDEX `idx_api_keys_user_provider` ON `user_api_keys` (`user_id`, `provider`);

-- Index for user lookup
CREATE INDEX `idx_api_keys_user` ON `user_api_keys` (`user_id`);
