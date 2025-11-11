import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, BehaviorSubject, Subject } from 'rxjs';
import { map, catchError, tap } from 'rxjs/operators';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../environments/environment';

export interface Location {
  lat: number;
  lng: number;
}

export interface Sensor {
  spotId: string;
  isOccupied: boolean;
  lastUpdate: Date;
}

export interface ParkingLot {
  id: string;
  name: string;
  totalSpots: number;
  availableSpots: number;
  location: Location;
  lastUpdate: string;
  predictedAvailability: number;
  confidence: number;
  sensors?: Sensor[];
}

export interface PredictionResponse {
  predictedSpots: number;
  confidence: number;
  predictedFor: string;
}

export interface HistoricalData {
  parkingLotId: string;
  timestamp: string;
  availableSpots: number;
  occupancyRate: number;
  dayOfWeek: number;
  hour: number;
}

export interface Stats {
  totalParkingLots: number;
  totalSpots: number;
  totalAvailable: number;
  avgOccupancy: number;
}

export interface ParkingUpdate {
  lotId: string;
  availableSpots: number;
  timestamp: string;
}

@Injectable({
  providedIn: 'root'
})
export class ParkingService {
  private apiUrl = environment.apiUrl;
  private socket!: Socket;

  // Radius and location for real data
  private currentRadius = 5000; // Default 5km
  private currentLat = 33.4242; // Default ASU coordinates
  private currentLng = -111.9281;
  private useRealData = true; // Use real OSM data

  private parkingLotsSubject = new BehaviorSubject<ParkingLot[]>([]);
  public parkingLots$ = this.parkingLotsSubject.asObservable();

  private parkingUpdateSubject = new Subject<ParkingUpdate>();
  public parkingUpdates$ = this.parkingUpdateSubject.asObservable();

  private connectionStatusSubject = new BehaviorSubject<boolean>(false);
  public connectionStatus$ = this.connectionStatusSubject.asObservable();

  constructor(private http: HttpClient) {
    this.initializeWebSocket();
  }

  private initializeWebSocket(): void {
    this.socket = io(environment.wsUrl, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });

    this.socket.on('connect', () => {
      console.log('WebSocket connected');
      this.connectionStatusSubject.next(true);
    });

    this.socket.on('disconnect', () => {
      console.log('WebSocket disconnected');
      this.connectionStatusSubject.next(false);
    });

    this.socket.on('parking-update', (update: ParkingUpdate) => {
      this.parkingUpdateSubject.next(update);
      this.updateLocalParkingLot(update);
    });

    this.socket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
    });
  }

  private updateLocalParkingLot(update: ParkingUpdate): void {
    const currentLots = this.parkingLotsSubject.value;
    const updatedLots = currentLots.map(lot =>
      lot.id === update.lotId
        ? { ...lot, availableSpots: update.availableSpots, lastUpdate: update.timestamp }
        : lot
    );
    this.parkingLotsSubject.next(updatedLots);
  }

  getAllParkingLots(): Observable<ParkingLot[]> {
    const endpoint = this.useRealData 
      ? `${this.apiUrl}/parking-lots/real?lat=${this.currentLat}&lng=${this.currentLng}&radius=${this.currentRadius}`
      : `${this.apiUrl}/parking-lots`;
    
    return this.http.get<ParkingLot[]>(endpoint).pipe(
      tap(lots => this.parkingLotsSubject.next(lots)),
      catchError(error => {
        console.error('Error fetching parking lots:', error);
        throw error;
      })
    );
  }

  setRadius(radius: number): void {
    this.currentRadius = radius;
  }

  setLocation(lat: number, lng: number): void {
    this.currentLat = lat;
    this.currentLng = lng;
  }

  getCurrentRadius(): number {
    return this.currentRadius;
  }

  getParkingLotById(id: string): Observable<ParkingLot> {
    return this.http.get<ParkingLot>(`${this.apiUrl}/parking-lots/${id}`).pipe(
      catchError(error => {
        console.error(`Error fetching parking lot ${id}:`, error);
        throw error;
      })
    );
  }

  updateParkingLot(id: string, availableSpots: number, sensors?: Sensor[]): Observable<ParkingLot> {
    const body = { availableSpots, sensors };
    return this.http.put<ParkingLot>(`${this.apiUrl}/parking-lots/${id}`, body).pipe(
      catchError(error => {
        console.error(`Error updating parking lot ${id}:`, error);
        throw error;
      })
    );
  }

  getPrediction(id: string, minutesAhead: number = 30): Observable<PredictionResponse> {
    const params = new HttpParams().set('minutes', minutesAhead.toString());
    return this.http.get<PredictionResponse>(
      `${this.apiUrl}/parking-lots/${id}/predict`,
      { params }
    ).pipe(
      catchError(error => {
        console.error(`Error fetching prediction for lot ${id}:`, error);
        throw error;
      })
    );
  }

  getHistoricalData(id: string, limit: number = 100): Observable<HistoricalData[]> {
    const params = new HttpParams().set('limit', limit.toString());
    return this.http.get<HistoricalData[]>(
      `${this.apiUrl}/parking-lots/${id}/history`,
      { params }
    ).pipe(
      catchError(error => {
        console.error(`Error fetching historical data for lot ${id}:`, error);
        throw error;
      })
    );
  }

  getStats(): Observable<Stats> {
    return this.http.get<Stats>(`${this.apiUrl}/stats`).pipe(
      catchError(error => {
        console.error('Error fetching stats:', error);
        throw error;
      })
    );
  }

  createParkingLot(lot: Partial<ParkingLot>): Observable<ParkingLot> {
    return this.http.post<ParkingLot>(`${this.apiUrl}/parking-lots`, lot).pipe(
      tap(newLot => {
        const currentLots = this.parkingLotsSubject.value;
        this.parkingLotsSubject.next([...currentLots, newLot]);
      }),
      catchError(error => {
        console.error('Error creating parking lot:', error);
        throw error;
      })
    );
  }

  subscribeToParkingLot(lotId: string): void {
    if (this.socket.connected) {
      this.socket.emit('subscribe', lotId);
      console.log(`Subscribed to parking lot: ${lotId}`);
    } else {
      console.warn('Socket not connected. Will subscribe when connection is established.');
      this.socket.once('connect', () => {
        this.socket.emit('subscribe', lotId);
      });
    }
  }

  unsubscribeFromParkingLot(lotId: string): void {
    if (this.socket.connected) {
      this.socket.emit('unsubscribe', lotId);
      console.log(`Unsubscribed from parking lot: ${lotId}`);
    }
  }

  getOccupancyRate(lot: ParkingLot): number {
    return ((lot.totalSpots - lot.availableSpots) / lot.totalSpots) * 100;
  }

  getStatusLabel(lot: ParkingLot): string {
    const occupancy = this.getOccupancyRate(lot);
    if (occupancy < 50) return 'Available';
    if (occupancy < 80) return 'Moderate';
    return 'Full';
  }

  getStatusColor(lot: ParkingLot): string {
    const occupancy = this.getOccupancyRate(lot);
    if (occupancy < 50) return 'green';
    if (occupancy < 80) return 'yellow';
    return 'red';
  }

  calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  getNearestParkingLot(userLat: number, userLng: number): Observable<ParkingLot | null> {
    return this.parkingLots$.pipe(
      map(lots => {
        if (lots.length === 0) return null;
        
        let nearest = lots[0];
        let minDistance = this.calculateDistance(
          userLat, userLng, 
          nearest.location.lat, nearest.location.lng
        );

        lots.forEach(lot => {
          const distance = this.calculateDistance(
            userLat, userLng,
            lot.location.lat, lot.location.lng
          );
          if (distance < minDistance) {
            minDistance = distance;
            nearest = lot;
          }
        });

        return nearest;
      })
    );
  }

  filterByAvailability(lots: ParkingLot[], minSpots: number): ParkingLot[] {
    return lots.filter(lot => lot.availableSpots >= minSpots);
  }

  sortByAvailability(lots: ParkingLot[]): ParkingLot[] {
    return [...lots].sort((a, b) => b.availableSpots - a.availableSpots);
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      console.log('WebSocket disconnected manually');
    }
  }

  reconnect(): void {
    if (this.socket) {
      this.socket.connect();
      console.log('WebSocket reconnecting...');
    }
  }
}

