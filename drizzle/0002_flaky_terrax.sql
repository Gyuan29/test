DROP INDEX `organizations_name_idx`;--> statement-breakpoint
ALTER TABLE `organizations` ADD `sources` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `last_searched_at` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `search_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `last_event_searched_at` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `event_search_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_organizations_name` ON `organizations` (`name`);--> statement-breakpoint
CREATE INDEX `organizations_search_schedule_idx` ON `organizations` (`search_status`,`last_searched_at`);--> statement-breakpoint
CREATE INDEX `organizations_event_search_schedule_idx` ON `organizations` (`event_search_status`,`last_event_searched_at`);--> statement-breakpoint
ALTER TABLE `events` ADD `relevance_score` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `translated_title` text;--> statement-breakpoint
ALTER TABLE `events` ADD `translated_description` text;