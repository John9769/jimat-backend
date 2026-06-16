const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash('jimat@admin2026', 12);

  const admin = await prisma.admin.upsert({
    where: { email: 'admin@jimat.my' },
    update: {},
    create: {
      email: 'admin@jimat.my',
      password: hashedPassword,
      name: 'JIMAT Admin'
    }
  });

  // Seed current AFA rate
  await prisma.afaRate.upsert({
    where: { month: '2026-06' },
    update: {},
    create: {
      month: '2026-06',
      rateSen: 1.10,
      note: 'AFA surcharge June 2026 - Energy Commission declared'
    }
  });

  console.log('✅ Admin seeded:', admin.email);
  console.log('✅ AFA rate seeded for 2026-06');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());