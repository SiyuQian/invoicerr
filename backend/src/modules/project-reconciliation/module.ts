import { Module } from '@nestjs/common';
import { DocumentsCoreModule } from '../documents/documents-core.module';
import { ReconciliationController } from './controller';
import { ReconciliationService } from './service';
import { ExternalReceiptsService } from './external-receipts';
import { ReconciliationAccessGuard } from './access.guard';
@Module({
  imports: [DocumentsCoreModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, ExternalReceiptsService, ReconciliationAccessGuard],
  exports: [ReconciliationService, ExternalReceiptsService],
})
export class ProjectReconciliationModule {}
