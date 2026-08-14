// The guest profile panel stays static placeholder data (Session 1 scope
// — no profile CRUD was ever asked for). Everything else that used to
// live here (trip/chat/itinerary/rates placeholder content) is now real,
// server-backed data — see lib/client/queries.ts and components/client/*.

export interface GuestProfile {
  name:           string
  email:          string
  phone:          string
  preferences:    string[]
  passport:       string
  loyaltyNumbers: { program: string; number: string }[]
}

export const DEMO_GUEST_PROFILE: GuestProfile = {
  name: 'Jordan Ellis',
  email: 'jordan.ellis@example.com',
  phone: '+1 (555) 219-4038',
  preferences: ['Aisle seating', 'Dietary: pescatarian', 'Room preference: high floor, away from elevator'],
  passport: 'Placeholder — P0123456, exp. 2031-04',
  loyaltyNumbers: [
    { program: 'Marriott Bonvoy', number: '8827193045' },
    { program: 'Emirates Skywards', number: 'EK4471029' },
  ],
}
