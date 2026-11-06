ALTER TABLE "terminais_pdv" ADD COLUMN "hardware_pendente_desde" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "terminais_pdv" ADD COLUMN "hardware_pendente_ip" "inet";--> statement-breakpoint
ALTER TABLE "terminais_pdv" ADD COLUMN "hardware_pendente_so" varchar(60);