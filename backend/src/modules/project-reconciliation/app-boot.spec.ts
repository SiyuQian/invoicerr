import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule } from '@/app.module';
import { ProjectReconciliationModule } from './module';
import { ReconciliationService } from './service';
import { FinancialReadService } from '../documents/settlement/financial-read.service';

describe('reconciliation real application DI', () => {
  it('registers exactly once in AppModule and boots its real DocumentsCore dependency', async () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule);
    expect(imports.filter((entry: unknown) => entry === ProjectReconciliationModule)).toHaveLength(1);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = module.createNestApplication();
    try {
      await app.init();
      expect(app.get(ReconciliationService).financialRead).toBe(app.get(FinancialReadService));
    } finally {
      await app.close();
    }
  }, 30000);
});
