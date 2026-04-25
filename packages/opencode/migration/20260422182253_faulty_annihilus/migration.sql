CREATE TABLE `mailbox` (
	`id` text PRIMARY KEY,
	`recipient_session_id` text NOT NULL,
	`sender_session_id` text NOT NULL,
	`priority` text NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
CREATE TABLE `engineer_slot` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`current_task` text,
	`agent_name` text,
	`agent_color` text,
	`started_at` integer,
	`last_heartbeat` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `team_state` (
	`team_id` text PRIMARY KEY,
	`state` text NOT NULL,
	`lead_session_id` text NOT NULL,
	`engineer_count` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_board` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`assigned_engineer_id` text,
	`file_scope` text,
	`blocked_by` text,
	`parent_task_id` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `mailbox_recipient_priority_created_idx` ON `mailbox` (`recipient_session_id`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `mailbox_recipient_read_idx` ON `mailbox` (`recipient_session_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `engineer_slot_team_id_idx` ON `engineer_slot` (`team_id`);--> statement-breakpoint
CREATE INDEX `engineer_slot_session_id_idx` ON `engineer_slot` (`session_id`);--> statement-breakpoint
CREATE INDEX `team_state_lead_session_id_idx` ON `team_state` (`lead_session_id`);--> statement-breakpoint
CREATE INDEX `task_board_team_id_idx` ON `task_board` (`team_id`);--> statement-breakpoint
CREATE INDEX `task_board_assigned_engineer_id_idx` ON `task_board` (`assigned_engineer_id`);--> statement-breakpoint
CREATE INDEX `task_board_status_idx` ON `task_board` (`status`);