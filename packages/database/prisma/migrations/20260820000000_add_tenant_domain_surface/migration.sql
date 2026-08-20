-- Un dominio de tenant declara QUÉ sirve: el aula (app con sesión) o el sitio
-- público (contenido indexable, sin sesión). Sin esto, dos dominios del mismo
-- tenant sirven lo mismo en `/` y no hay forma de distinguirlos.
--
-- Por defecto APP: todo dominio que ya existía seguía sirviendo el aula, así
-- que la migración no cambia el comportamiento de ninguna instalación.

-- CreateEnum
CREATE TYPE "TenantDomainSurface" AS ENUM ('APP', 'SITE');

-- AlterTable
ALTER TABLE "tenant_domain" ADD COLUMN     "surface" "TenantDomainSurface" NOT NULL DEFAULT 'APP';
