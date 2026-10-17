export type AppRole = 'ADMIN' | 'RESEARCHER'
export type AccountStatus = 'invited' | 'active' | 'suspended' | 'removed'

export type Profile = {
  id: string
  email: string
  full_name: string
  role: AppRole
  account_status: AccountStatus
}
