CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text,
	`payload` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_ts` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX `audit_subject` ON `audit_log` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `candles` (
	`symbol` text NOT NULL,
	`resolution` text NOT NULL,
	`t` integer NOT NULL,
	`o` real NOT NULL,
	`h` real NOT NULL,
	`l` real NOT NULL,
	`c` real NOT NULL,
	`v` real,
	`source` text NOT NULL,
	`has_range` integer DEFAULT true NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `candle_pk` ON `candles` (`symbol`,`resolution`,`t`);--> statement-breakpoint
CREATE INDEX `candle_symbol_res` ON `candles` (`symbol`,`resolution`);--> statement-breakpoint
CREATE TABLE `gateway_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`lock_reason` text,
	`locked_at` integer,
	`locked_by` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gateway_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`account_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoked_reason` text,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `token_hash_lookup` ON `gateway_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `news_items` (
	`id` text PRIMARY KEY NOT NULL,
	`headline` text NOT NULL,
	`url` text NOT NULL,
	`source` text NOT NULL,
	`summary` text,
	`published_at` integer NOT NULL,
	`symbol` text,
	`sentiment_score` real NOT NULL,
	`sentiment_label` text NOT NULL,
	`ingested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `news_symbol_published` ON `news_items` (`symbol`,`published_at`);--> statement-breakpoint
CREATE INDEX `news_published` ON `news_items` (`published_at`);--> statement-breakpoint
CREATE TABLE `order_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text NOT NULL,
	`account_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`quantity` real NOT NULL,
	`order_type` text NOT NULL,
	`limit_price` real,
	`mode` text DEFAULT 'paper' NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`client_ref` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer,
	`decided_at` integer,
	`decided_by` text,
	`filled_price` real,
	`filled_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `intent_status` ON `order_intents` (`status`);--> statement-breakpoint
CREATE INDEX `intent_account_created` ON `order_intents` (`account_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `intent_client_ref` ON `order_intents` (`token_id`,`client_ref`);--> statement-breakpoint
CREATE TABLE `paper_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`cash` real NOT NULL,
	`starting_cash` real NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paper_accounts_name_unique` ON `paper_accounts` (`name`);--> statement-breakpoint
CREATE TABLE `paper_fills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`order_id` text NOT NULL,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`quantity` real NOT NULL,
	`price` real NOT NULL,
	`notional` real NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`price_source` text NOT NULL,
	`price_as_of` integer NOT NULL,
	`filled_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fill_account_time` ON `paper_fills` (`account_id`,`filled_at`);--> statement-breakpoint
CREATE INDEX `fill_order` ON `paper_fills` (`order_id`);--> statement-breakpoint
CREATE TABLE `paper_positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`quantity` real NOT NULL,
	`average_price` real NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `position_account_symbol` ON `paper_positions` (`account_id`,`symbol`);--> statement-breakpoint
CREATE TABLE `risk_counters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`day` text NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`order_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `paper_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `risk_account_day` ON `risk_counters` (`account_id`,`day`);--> statement-breakpoint
CREATE TABLE `watchlist_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`watchlist_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`asset_class` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`added_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`watchlist_id`) REFERENCES `watchlists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_symbol_unique` ON `watchlist_items` (`watchlist_id`,`symbol`);--> statement-breakpoint
CREATE TABLE `watchlists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
