export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      capacity_settings: {
        Row: {
          abend_capacity: number
          created_at: string
          id: string
          mittag_capacity: number
          u1_capacity: number
          u1_days: number[]
          updated_at: string
        }
        Insert: {
          abend_capacity?: number
          created_at?: string
          id?: string
          mittag_capacity?: number
          u1_capacity?: number
          u1_days?: number[]
          updated_at?: string
        }
        Update: {
          abend_capacity?: number
          created_at?: string
          id?: string
          mittag_capacity?: number
          u1_capacity?: number
          u1_days?: number[]
          updated_at?: string
        }
        Relationships: []
      }
      department_access_tokens: {
        Row: {
          created_at: string
          department: string
          expires_at: string | null
          id: string
          is_active: boolean
          last_used_at: string | null
          name: string
          role: string
          token: string
        }
        Insert: {
          created_at?: string
          department: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          name: string
          role?: string
          token: string
        }
        Update: {
          created_at?: string
          department?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          name?: string
          role?: string
          token?: string
        }
        Relationships: []
      }
      department_notification_emails: {
        Row: {
          created_at: string
          department: string
          email: string | null
          id: string
          is_active: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          department: string
          email?: string | null
          id?: string
          is_active?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          department?: string
          email?: string | null
          id?: string
          is_active?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      email_imported_reservations: {
        Row: {
          comment: string | null
          converted_to_group_id: string | null
          created_at: string
          date: string
          guest_count: number
          guest_email: string | null
          guest_name: string
          guest_phone: string | null
          id: string
          is_processed: boolean
          location: string | null
          needs_review: boolean
          raw_email_content: string | null
          reservation_number: string | null
          source: string | null
          time: string
          updated_at: string
        }
        Insert: {
          comment?: string | null
          converted_to_group_id?: string | null
          created_at?: string
          date: string
          guest_count?: number
          guest_email?: string | null
          guest_name: string
          guest_phone?: string | null
          id?: string
          is_processed?: boolean
          location?: string | null
          needs_review?: boolean
          raw_email_content?: string | null
          reservation_number?: string | null
          source?: string | null
          time: string
          updated_at?: string
        }
        Update: {
          comment?: string | null
          converted_to_group_id?: string | null
          created_at?: string
          date?: string
          guest_count?: number
          guest_email?: string | null
          guest_name?: string
          guest_phone?: string | null
          id?: string
          is_processed?: boolean
          location?: string | null
          needs_review?: boolean
          raw_email_content?: string | null
          reservation_number?: string | null
          source?: string | null
          time?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_imported_reservations_converted_to_group_id_fkey"
            columns: ["converted_to_group_id"]
            isOneToOne: false
            referencedRelation: "group_reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_balance_history: {
        Row: {
          created_at: string
          employee_id: string
          hours_balance_end: number | null
          hours_balance_start: number | null
          hours_target: number | null
          hours_worked: number | null
          id: string
          month: number
          notes: string | null
          updated_at: string
          vacation_balance_end: number | null
          vacation_balance_start: number | null
          vacation_days_used: number | null
          year: number
        }
        Insert: {
          created_at?: string
          employee_id: string
          hours_balance_end?: number | null
          hours_balance_start?: number | null
          hours_target?: number | null
          hours_worked?: number | null
          id?: string
          month: number
          notes?: string | null
          updated_at?: string
          vacation_balance_end?: number | null
          vacation_balance_start?: number | null
          vacation_days_used?: number | null
          year: number
        }
        Update: {
          created_at?: string
          employee_id?: string
          hours_balance_end?: number | null
          hours_balance_start?: number | null
          hours_target?: number | null
          hours_worked?: number | null
          id?: string
          month?: number
          notes?: string | null
          updated_at?: string
          vacation_balance_end?: number | null
          vacation_balance_start?: number | null
          vacation_days_used?: number | null
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "employee_balance_history_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          created_at: string
          days_off: string[] | null
          department: Database["public"]["Enums"]["department_type"]
          employment_type: Database["public"]["Enums"]["employment_type"]
          hourly_wage: number
          hours_balance: number | null
          id: string
          monthly_salary: number | null
          monthly_salary_with_13th: number | null
          name: string
          preferred_work_days: string[] | null
          updated_at: string
          vacation_balance: number | null
          vacation_days_per_year: number | null
          weekly_hours: number | null
        }
        Insert: {
          created_at?: string
          days_off?: string[] | null
          department: Database["public"]["Enums"]["department_type"]
          employment_type?: Database["public"]["Enums"]["employment_type"]
          hourly_wage?: number
          hours_balance?: number | null
          id?: string
          monthly_salary?: number | null
          monthly_salary_with_13th?: number | null
          name: string
          preferred_work_days?: string[] | null
          updated_at?: string
          vacation_balance?: number | null
          vacation_days_per_year?: number | null
          weekly_hours?: number | null
        }
        Update: {
          created_at?: string
          days_off?: string[] | null
          department?: Database["public"]["Enums"]["department_type"]
          employment_type?: Database["public"]["Enums"]["employment_type"]
          hourly_wage?: number
          hours_balance?: number | null
          id?: string
          monthly_salary?: number | null
          monthly_salary_with_13th?: number | null
          name?: string
          preferred_work_days?: string[] | null
          updated_at?: string
          vacation_balance?: number | null
          vacation_days_per_year?: number | null
          weekly_hours?: number | null
        }
        Relationships: []
      }
      event_notification_settings: {
        Row: {
          created_at: string
          days_before_notification: number
          email: string
          id: string
          is_active: boolean
          notify_group_reservations: boolean
          notify_regular_reservations: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          days_before_notification?: number
          email: string
          id?: string
          is_active?: boolean
          notify_group_reservations?: boolean
          notify_regular_reservations?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          days_before_notification?: number
          email?: string
          id?: string
          is_active?: boolean
          notify_group_reservations?: boolean
          notify_regular_reservations?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      event_notifications_log: {
        Row: {
          error_message: string | null
          id: string
          notification_type: string
          recipients: string[]
          reservation_id: string
          sent_at: string
          success: boolean
        }
        Insert: {
          error_message?: string | null
          id?: string
          notification_type: string
          recipients: string[]
          reservation_id: string
          sent_at?: string
          success?: boolean
        }
        Update: {
          error_message?: string | null
          id?: string
          notification_type?: string
          recipients?: string[]
          reservation_id?: string
          sent_at?: string
          success?: boolean
        }
        Relationships: []
      }
      external_api_import_log: {
        Row: {
          api_key_id: string | null
          created_at: string
          error_count: number
          errors: Json | null
          id: string
          import_type: string
          reservations_count: number
          source_system: string | null
          success_count: number
        }
        Insert: {
          api_key_id?: string | null
          created_at?: string
          error_count?: number
          errors?: Json | null
          id?: string
          import_type?: string
          reservations_count?: number
          source_system?: string | null
          success_count?: number
        }
        Update: {
          api_key_id?: string | null
          created_at?: string
          error_count?: number
          errors?: Json | null
          id?: string
          import_type?: string
          reservations_count?: number
          source_system?: string | null
          success_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "external_api_import_log_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "external_api_settings"
            referencedColumns: ["id"]
          },
        ]
      }
      external_api_settings: {
        Row: {
          api_key: string
          api_key_name: string
          created_at: string
          id: string
          is_active: boolean
          last_used_at: string | null
          request_count: number
          updated_at: string
        }
        Insert: {
          api_key: string
          api_key_name?: string
          created_at?: string
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          request_count?: number
          updated_at?: string
        }
        Update: {
          api_key?: string
          api_key_name?: string
          created_at?: string
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          request_count?: number
          updated_at?: string
        }
        Relationships: []
      }
      fortelable_reservations: {
        Row: {
          created_at: string
          date: string
          external_id: string | null
          guest_count: number
          id: string
          reservation_name: string | null
          shift: string
          synced_at: string
        }
        Insert: {
          created_at?: string
          date: string
          external_id?: string | null
          guest_count?: number
          id?: string
          reservation_name?: string | null
          shift: string
          synced_at?: string
        }
        Update: {
          created_at?: string
          date?: string
          external_id?: string | null
          guest_count?: number
          id?: string
          reservation_name?: string | null
          shift?: string
          synced_at?: string
        }
        Relationships: []
      }
      fortelable_settings: {
        Row: {
          api_key: string | null
          created_at: string
          default_revenue_per_person: number
          id: string
          is_enabled: boolean
          last_sync_at: string | null
          restaurant_hash: string | null
          updated_at: string
          walk_in_percentage: number
        }
        Insert: {
          api_key?: string | null
          created_at?: string
          default_revenue_per_person?: number
          id?: string
          is_enabled?: boolean
          last_sync_at?: string | null
          restaurant_hash?: string | null
          updated_at?: string
          walk_in_percentage?: number
        }
        Update: {
          api_key?: string | null
          created_at?: string
          default_revenue_per_person?: number
          id?: string
          is_enabled?: boolean
          last_sync_at?: string | null
          restaurant_hash?: string | null
          updated_at?: string
          walk_in_percentage?: number
        }
        Relationships: []
      }
      group_reservations: {
        Row: {
          applied_to_budget: boolean
          bar_ready: boolean
          created_at: string
          date: string
          dekoration_ready: boolean
          exclude_walk_in: boolean | null
          external_id: string | null
          gf_accepted: boolean | null
          gf_accepted_at: string | null
          gf_final_confirmed: boolean | null
          gf_final_confirmed_at: string | null
          group_name: string | null
          group_type: string | null
          guest_count: number
          id: string
          is_confirmed: boolean
          kueche_ready: boolean
          laufzettel_done: boolean
          location: string | null
          menu_pdf_url: string | null
          notes: string | null
          revenue_mode: string | null
          revenue_per_person: number
          service_ready: boolean
          shift: string
          source: string | null
          updated_at: string
        }
        Insert: {
          applied_to_budget?: boolean
          bar_ready?: boolean
          created_at?: string
          date: string
          dekoration_ready?: boolean
          exclude_walk_in?: boolean | null
          external_id?: string | null
          gf_accepted?: boolean | null
          gf_accepted_at?: string | null
          gf_final_confirmed?: boolean | null
          gf_final_confirmed_at?: string | null
          group_name?: string | null
          group_type?: string | null
          guest_count?: number
          id?: string
          is_confirmed?: boolean
          kueche_ready?: boolean
          laufzettel_done?: boolean
          location?: string | null
          menu_pdf_url?: string | null
          notes?: string | null
          revenue_mode?: string | null
          revenue_per_person?: number
          service_ready?: boolean
          shift: string
          source?: string | null
          updated_at?: string
        }
        Update: {
          applied_to_budget?: boolean
          bar_ready?: boolean
          created_at?: string
          date?: string
          dekoration_ready?: boolean
          exclude_walk_in?: boolean | null
          external_id?: string | null
          gf_accepted?: boolean | null
          gf_accepted_at?: string | null
          gf_final_confirmed?: boolean | null
          gf_final_confirmed_at?: string | null
          group_name?: string | null
          group_type?: string | null
          guest_count?: number
          id?: string
          is_confirmed?: boolean
          kueche_ready?: boolean
          laufzettel_done?: boolean
          location?: string | null
          menu_pdf_url?: string | null
          notes?: string | null
          revenue_mode?: string | null
          revenue_per_person?: number
          service_ready?: boolean
          shift?: string
          source?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      imap_email_settings: {
        Row: {
          created_at: string
          host: string
          id: string
          is_enabled: boolean
          last_sync_at: string | null
          last_uid: number | null
          mailbox: string
          password: string
          port: number
          updated_at: string
          use_tls: boolean
          username: string
        }
        Insert: {
          created_at?: string
          host: string
          id?: string
          is_enabled?: boolean
          last_sync_at?: string | null
          last_uid?: number | null
          mailbox?: string
          password: string
          port?: number
          updated_at?: string
          use_tls?: boolean
          username: string
        }
        Update: {
          created_at?: string
          host?: string
          id?: string
          is_enabled?: boolean
          last_sync_at?: string | null
          last_uid?: number | null
          mailbox?: string
          password?: string
          port?: number
          updated_at?: string
          use_tls?: boolean
          username?: string
        }
        Relationships: []
      }
      schedule_entries: {
        Row: {
          created_at: string
          date: string
          employee_id: string
          frueh_absence: string | null
          frueh_end: string | null
          frueh_start: string | null
          id: string
          spaet_absence: string | null
          spaet_end: string | null
          spaet_start: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          date: string
          employee_id: string
          frueh_absence?: string | null
          frueh_end?: string | null
          frueh_start?: string | null
          id?: string
          spaet_absence?: string | null
          spaet_end?: string | null
          spaet_start?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          date?: string
          employee_id?: string
          frueh_absence?: string | null
          frueh_end?: string | null
          frueh_start?: string | null
          id?: string
          spaet_absence?: string | null
          spaet_end?: string | null
          spaet_start?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_entries_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_token_access: {
        Args: { token_value: string }
        Returns: {
          department: string
          is_valid: boolean
          role: string
        }[]
      }
    }
    Enums: {
      department_type: "service" | "kueche"
      employment_type: "vollzeit" | "teilzeit" | "minijob" | "aushilfe"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      department_type: ["service", "kueche"],
      employment_type: ["vollzeit", "teilzeit", "minijob", "aushilfe"],
    },
  },
} as const
