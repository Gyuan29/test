ALTER TABLE `organizations` ADD COLUMN `last_event_searched_at` text;
--> statement-breakpoint
ALTER TABLE `organizations` ADD COLUMN `event_search_status` text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
CREATE INDEX `organizations_event_search_schedule_idx` ON `organizations` (`event_search_status`,`last_event_searched_at`);
