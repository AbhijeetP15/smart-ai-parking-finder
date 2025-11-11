import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ParkingDashboardComponent } from './parking-dashboard.component';
import { ParkingService } from '../../services/parking.service';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { FormsModule } from '@angular/forms';

describe('ParkingDashboardComponent', () => {
  let component: ParkingDashboardComponent;
  let fixture: ComponentFixture<ParkingDashboardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ ParkingDashboardComponent ],
      imports: [ HttpClientTestingModule, FormsModule ],
      providers: [ ParkingService ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ParkingDashboardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});