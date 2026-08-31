CREATE TABLE `briefing_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`content_hash` text NOT NULL,
	`status` text NOT NULL,
	`generated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`pushed_at` text,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `briefing_runs_window_content_uq` ON `briefing_runs` (`window_start`,`window_end`,`content_hash`);--> statement-breakpoint
CREATE INDEX `briefing_runs_window_idx` ON `briefing_runs` (`window_start`,`window_end`);