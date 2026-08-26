CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`organization_id` text,
	`title` text,
	`messages_json` text DEFAULT '[]' NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`entity_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `chat_session_time_idx` ON `chat_sessions` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`event_date` text NOT NULL,
	`event_type` text,
	`title` text NOT NULL,
	`summary` text,
	`source_url` text,
	`source_name` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`entity_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_org_date_idx` ON `events` (`organization_id`,`event_date`);--> statement-breakpoint
CREATE TABLE `news_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_slug` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`interval_minutes` integer DEFAULT 1440 NOT NULL,
	`etag` text,
	`last_modified` text,
	`last_content_hash` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_fetch_status` text,
	`retry_class` text,
	`last_checked_at` text,
	`next_check_at` text,
	`next_retry_at` text
);
--> statement-breakpoint
CREATE INDEX `news_sources_organization_idx` ON `news_sources` (`organization_slug`);--> statement-breakpoint
CREATE INDEX `news_sources_status_idx` ON `news_sources` (`retry_class`,`last_fetch_status`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`entity_id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`entity_type` text NOT NULL,
	`is_core_tracking` integer DEFAULT false NOT NULL,
	`region` text NOT NULL,
	`country` text NOT NULL,
	`founded` text,
	`analysis_type` text,
	`related_types` text,
	`mention_count` integer DEFAULT 1 NOT NULL,
	`credibility_score` integer,
	`source` text,
	`source_count` integer DEFAULT 0 NOT NULL,
	`context` text,
	`source_location` text,
	`source_document` text,
	`original_name` text,
	`location_basis` text,
	`location_confidence` text,
	`summary` text,
	`website_url` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_uq` ON `organizations` (`slug`);--> statement-breakpoint
CREATE INDEX `organizations_name_idx` ON `organizations` (`name`);--> statement-breakpoint
CREATE INDEX `organizations_type_region_idx` ON `organizations` (`entity_type`,`region`);--> statement-breakpoint
CREATE INDEX `organizations_credibility_idx` ON `organizations` (`credibility_score`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_uq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `user_provider_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`base_url` text,
	`credential_ciphertext` text,
	`credential_nonce` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_provider_uq` ON `user_provider_settings` (`user_id`,`provider`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_iterations` integer NOT NULL,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);