
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { ParkingDashboardComponent } from './components/parking-dashboard/parking-dashboard.component';
import { ParkingService } from './services/parking.service';
import { ParkingDetailComponent } from './components/parking-detail/parking-detail.component';

@NgModule({
  declarations: [
    AppComponent,
    ParkingDashboardComponent,
    ParkingDetailComponent
  ],
  imports: [
    BrowserModule,
    AppRoutingModule,
    HttpClientModule,
    FormsModule
  ],
  providers: [
    ParkingService
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }