// src/app/components/parking-dashboard/parking-dashboard.component.ts
import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { ParkingService, ParkingLot, Stats } from '../../services/parking.service';
import { Subscription } from 'rxjs';

// Extend ParkingLot interface to include distance
interface ParkingLotWithDistance extends ParkingLot {
  distance?: number;
}

@Component({
  selector: 'app-parking-dashboard',
  templateUrl: './parking-dashboard.component.html',
  styleUrls: ['./parking-dashboard.component.css']
})
export class ParkingDashboardComponent implements OnInit, OnDestroy {
  parkingLots: ParkingLotWithDistance[] = [];
  filteredLots: ParkingLotWithDistance[] = [];
  selectedLot: ParkingLotWithDistance | null = null;
  stats: Stats | null = null;
  
  // Filter states
  filterType: string = 'all';
  searchQuery: string = '';
  radiusFilter: number | null = null; // in miles, null = show all (25 miles)
  
  // UI states
  isLoading: boolean = true;
  isConnected: boolean = false;
  error: string | null = null;
  isGettingLocation: boolean = false;
  locationEnabled: boolean = false;
  
  // User location for distance calculation
  userLocation = { lat: 33.4484, lng: -112.0740 }; // Default: Phoenix, AZ
  
  private subscriptions: Subscription[] = [];
  @ViewChild('detailsTop') detailsTop?: ElementRef<HTMLSpanElement>;

  constructor(private parkingService: ParkingService) {}

  ngOnInit(): void {
    this.loadInitialData();
    this.subscribeToUpdates();
    this.subscribeToConnectionStatus();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }

  /**
   * Request user location (triggered by button click)
   */
  requestLocation(): void {
    if (this.locationEnabled) {
      // Toggle off
      this.locationEnabled = false;
      this.userLocation = { lat: 33.4484, lng: -112.0740 }; // Reset to default
      this.calculateDistances();
      this.applyFilters();
      return;
    }

    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser');
      return;
    }

    this.isGettingLocation = true;
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        this.userLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        this.locationEnabled = true;
        this.isGettingLocation = false;
        console.log('User location obtained:', this.userLocation);
        this.calculateDistances();
        this.applyFilters();
      },
      (error) => {
        this.isGettingLocation = false;
        this.locationEnabled = false;
        let errorMessage = 'Unable to get your location. ';
        
        switch(error.code) {
          case error.PERMISSION_DENIED:
            errorMessage += 'Location permission denied. Please enable location access in your browser settings.';
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage += 'Location information unavailable.';
            break;
          case error.TIMEOUT:
            errorMessage += 'Location request timed out.';
            break;
          default:
            errorMessage += 'An unknown error occurred.';
        }
        
        alert(errorMessage);
        console.error('Location error:', error);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  }

  /**
   * Calculate distance for all parking lots
   */
  private calculateDistances(): void {
    this.parkingLots = this.parkingLots.map(lot => ({
      ...lot,
      distance: this.kmToMiles(
        this.parkingService.calculateDistance(
          this.userLocation.lat,
          this.userLocation.lng,
          lot.location.lat,
          lot.location.lng
        )
      )
    }));
  }

  /**
   * Convert kilometers to miles
   */
  private kmToMiles(km: number): number {
    return km * 0.621371; // 1 km = 0.621371 miles
  }

  /**
   * Load initial parking lot data
   */
  private loadInitialData(): void {
    this.isLoading = true;
    this.error = null;

    this.parkingService.getAllParkingLots().subscribe({
      next: (lots) => {
        this.parkingLots = lots;
        this.calculateDistances();
        this.applyFilters();
        this.loadStats();
        this.isLoading = false;
      },
      error: (err) => {
        this.error = 'Failed to load parking data. Please try again.';
        this.isLoading = false;
        console.error('Error loading parking lots:', err);
      }
    });
  }

  /**
   * Load dashboard statistics
   */
  private loadStats(): void {
    this.parkingService.getStats().subscribe({
      next: (stats) => {
        this.stats = stats;
      },
      error: (err) => {
        console.error('Error loading stats:', err);
      }
    });
  }

  /**
   * Subscribe to real-time parking updates
   */
  private subscribeToUpdates(): void {
    const updateSub = this.parkingService.parkingUpdates$.subscribe({
      next: (update) => {
        const lot = this.parkingLots.find(l => l.id === update.lotId);
        if (lot) {
          lot.availableSpots = update.availableSpots;
          lot.lastUpdate = update.timestamp;
          this.applyFilters();
          this.loadStats();
        }
      }
    });
    this.subscriptions.push(updateSub);
  }

  /**
   * Subscribe to WebSocket connection status
   */
  private subscribeToConnectionStatus(): void {
    const connectionSub = this.parkingService.connectionStatus$.subscribe({
      next: (status) => {
        this.isConnected = status;
      }
    });
    this.subscriptions.push(connectionSub);
  }

  /**
   * Set availability filter
   */
  setFilter(type: string): void {
    this.filterType = type;
    this.applyFilters();
  }

  /**
   * Set radius filter
   */
  setRadiusFilter(radius: number | null): void {
    this.radiusFilter = radius;
    this.applyFilters();
  }

  /**
   * Handle radius slider change
   */
  onRadiusSliderChange(event: any): void {
    const value = parseFloat(event.target.value);
    // If slider is at max (25), treat as "show all"
    this.radiusFilter = value >= 25 ? null : value;
    this.applyFilters();
  }

  /**
   * Get slider percentage for visual fill
   */
  getSliderPercentage(): number {
    const value = this.radiusFilter || 25;
    return (value / 25) * 100;
  }

  /**
   * Handle search input changes
   */
  onSearchChange(query: string): void {
    this.searchQuery = query;
    this.applyFilters();
  }

  /**
   * Apply all active filters
   */
  private applyFilters(): void {
    let filtered = [...this.parkingLots];

    // Apply availability filter
    if (this.filterType !== 'all') {
      filtered = filtered.filter(lot => {
        const occupancy = this.getOccupancyRate(lot);
        switch (this.filterType) {
          case 'available':
            return occupancy < 50;
          case 'moderate':
            return occupancy >= 50 && occupancy < 80;
          case 'full':
            return occupancy >= 80;
          default:
            return true;
        }
      });
    }

    // Apply radius filter
    if (this.radiusFilter !== null) {
      filtered = filtered.filter(lot => 
        lot.distance !== undefined && lot.distance <= this.radiusFilter!
      );
    }

    // Apply search filter
    if (this.searchQuery.trim()) {
      const query = this.searchQuery.toLowerCase();
      filtered = filtered.filter(lot =>
        lot.name.toLowerCase().includes(query)
      );
    }

    // Sort by distance if available
    if (filtered.every(lot => lot.distance !== undefined)) {
      filtered.sort((a, b) => (a.distance || 0) - (b.distance || 0));
    }

    this.filteredLots = filtered;
  }

  /**
   * Clear all filters
   */
  clearAllFilters(): void {
    this.filterType = 'all';
    this.searchQuery = '';
    this.radiusFilter = null;
    this.applyFilters();
  }

  /**
   * Select a parking lot to view details
   */
  selectLot(lot: ParkingLotWithDistance): void {
    this.selectedLot = lot;
    // Ensure details panel (above grid) is visible without manual scrolling
    setTimeout(() => {
      this.detailsTop?.nativeElement?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /**
   * Refresh all data
   */
  refreshData(): void {
    this.loadInitialData();
  }

  /**
   * Get occupancy rate as percentage
   */
  getOccupancyRate(lot: ParkingLot): number {
    return Math.round(((lot.totalSpots - lot.availableSpots) / lot.totalSpots) * 100);
  }

  /**
   * Get status color class
   */
  getStatusColor(lot: ParkingLot): string {
    const occupancy = this.getOccupancyRate(lot);
    if (occupancy < 50) return 'green';
    if (occupancy < 80) return 'yellow';
    return 'red';
  }

  /**
   * Get status text
   */
  getStatusText(lot: ParkingLot): string {
    const occupancy = this.getOccupancyRate(lot);
    if (occupancy < 50) return 'Available';
    if (occupancy < 80) return 'Moderate';
    return 'Full';
  }

  /**
   * Get trend message for selected lot
   */
  getTrendMessage(lot: ParkingLot): string {
    const occupancy = this.getOccupancyRate(lot);
    const predicted = lot.predictedAvailability;
    const current = lot.availableSpots;

    if (predicted > current) {
      return 'Availability is expected to increase. Good time to visit!';
    } else if (predicted < current) {
      return 'Availability may decrease. Consider arriving soon.';
    } else {
      return 'Availability is expected to remain stable.';
    }
  }

  /**
   * Get directions to parking lot
   */
  getDirections(lot: ParkingLot): void {
    const destination = `${lot.location.lat},${lot.location.lng}`;
    const url = `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
    window.open(url, '_blank');
  }

  /**
   * Open parking lot location in Google Maps
   */
  openInMaps(lot: ParkingLot): void {
    const url = `https://www.google.com/maps/search/?api=1&query=${lot.location.lat},${lot.location.lng}`;
    window.open(url, '_blank');
  }
}
