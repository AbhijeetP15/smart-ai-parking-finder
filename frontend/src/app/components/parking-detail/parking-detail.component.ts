import { Component, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { ParkingService, ParkingLot } from '../../services/parking.service';

@Component({
  selector: 'app-parking-detail',
  templateUrl: './parking-detail.component.html',
  styleUrls: ['./parking-detail.component.css']
})
export class ParkingDetailComponent implements OnInit, OnDestroy {
  lot: ParkingLot | null = null;
  isLoading = true;
  error: string | null = null;

  private destroy$ = new Subject<void>();

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private parkingService: ParkingService
  ) {}

  ngOnInit(): void {
    const lotId = this.route.snapshot.paramMap.get('id');
    if (lotId) {
      this.loadParkingLot(lotId);
      this.subscribeToUpdates(lotId);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadParkingLot(id: string): void {
    this.parkingService.getParkingLotById(id)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (lot) => {
          this.lot = lot;
          this.isLoading = false;
        },
        error: (err) => {
          this.error = 'Failed to load parking lot details.';
          this.isLoading = false;
          console.error(err);
        }
      });
  }

  subscribeToUpdates(lotId: string): void {
    this.parkingService.parkingUpdates$
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (update) => {
          if (this.lot && update.lotId === this.lot.id) {
            this.lot = {
              ...this.lot,
              availableSpots: update.availableSpots,
              lastUpdate: update.timestamp
            };
          }
        }
      });
  }

  getOccupancyRate(): number {
    if (!this.lot) return 0;
    return ((this.lot.totalSpots - this.lot.availableSpots) / this.lot.totalSpots) * 100;
  }

  getStatusColor(): string {
    const occupancy = this.getOccupancyRate();
    if (occupancy < 50) return 'green';
    if (occupancy < 80) return 'yellow';
    return 'red';
  }

  getStatusLabel(): string {
    const occupancy = this.getOccupancyRate();
    if (occupancy < 50) return 'Available';
    if (occupancy < 80) return 'Moderate';
    return 'Full';
  }

  getTrendMessage(): string {
    if (!this.lot) return '';
    const diff = this.lot.predictedAvailability - this.lot.availableSpots;
    if (diff > 5) return 'More spots expected to open up soon!';
    if (diff < -5) return 'Spots are filling up. Consider arriving soon.';
    return 'Availability expected to remain stable.';
  }

  openInMaps(): void {
    if (this.lot) {
      const url = `https://www.google.com/maps?q=${this.lot.location.lat},${this.lot.location.lng}`;
      window.open(url, '_blank');
    }
  }

  getDirections(): void {
    if (!this.lot) return;

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          const url = `https://www.google.com/maps/dir/${latitude},${longitude}/${this.lot!.location.lat},${this.lot!.location.lng}`;
          window.open(url, '_blank');
        },
        (error) => {
          console.error('Geolocation error:', error);
          this.openInMaps();
        }
      );
    } else {
      this.openInMaps();
    }
  }

  goBack(): void {
    this.router.navigate(['/']);
  }
}
