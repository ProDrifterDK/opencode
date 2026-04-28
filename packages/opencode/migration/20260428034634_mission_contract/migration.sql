CREATE TABLE `mission_contract` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`status` text NOT NULL,
	`objective` text NOT NULL,
	`success_criteria` text DEFAULT '[]' NOT NULL,
	`constraints` text DEFAULT '[]' NOT NULL,
	`non_goals` text DEFAULT '[]' NOT NULL,
	`human_gates` text DEFAULT '[]' NOT NULL,
	`current_phase` text NOT NULL,
	`approved_at` integer,
	`approved_by_session_id` text,
	`export_path` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_mission_contract_team_id_team_state_team_id_fk` FOREIGN KEY (`team_id`) REFERENCES `team_state`(`team_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `mission_contract_revision` (
	`id` text PRIMARY KEY,
	`contract_id` text NOT NULL,
	`team_id` text NOT NULL,
	`revision` integer NOT NULL,
	`author_session_id` text NOT NULL,
	`reason` text NOT NULL,
	`snapshot` text NOT NULL,
	`time_created` integer NOT NULL,
	CONSTRAINT `fk_mission_contract_revision_contract_id_mission_contract_id_fk` FOREIGN KEY (`contract_id`) REFERENCES `mission_contract`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_mission_contract_revision_team_id_team_state_team_id_fk` FOREIGN KEY (`team_id`) REFERENCES `team_state`(`team_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `mission_contract_team_id_idx` ON `mission_contract` (`team_id`);--> statement-breakpoint
CREATE INDEX `mission_contract_status_idx` ON `mission_contract` (`status`);--> statement-breakpoint
CREATE INDEX `mission_contract_revision_contract_id_idx` ON `mission_contract_revision` (`contract_id`);--> statement-breakpoint
CREATE INDEX `mission_contract_revision_team_id_idx` ON `mission_contract_revision` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mission_contract_revision_contract_id_revision_idx` ON `mission_contract_revision` (`contract_id`,`revision`);
