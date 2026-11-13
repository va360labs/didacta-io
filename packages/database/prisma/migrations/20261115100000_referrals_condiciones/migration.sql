-- Referidos: aceptación de las condiciones del programa («Invita y gana»).
--
-- Una fila por alumno y aula con la versión aceptada y la fecha. La casilla
-- dice «Declaro que soy mayor de 18 años y acepto las condiciones del
-- programa»: sin aceptación no se genera enlace ni se atribuyen comisiones.
-- Tabla nueva con `tenant_id`: `rls.sql` le pone la política de aislamiento.
CREATE TABLE "mod_referrals_member" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "terms_version" TEXT,
    "terms_accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mod_referrals_member_pkey" PRIMARY KEY ("tenant_id","user_id")
);
