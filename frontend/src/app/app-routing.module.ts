import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { ParkingDashboardComponent } from './components/parking-dashboard/parking-dashboard.component';
import { ParkingDetailComponent } from './components/parking-detail/parking-detail.component';

const routes: Routes = [
  { path: '', component: ParkingDashboardComponent },
  { path: 'parking/:id', component: ParkingDetailComponent },
  { path: '**', redirectTo: '' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }