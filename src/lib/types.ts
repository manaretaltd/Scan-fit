import type { ScanTables } from "./scan-fit/database";
import type {MediaFile,MediaSettings,MediaCategory,DocumentPackage} from "./media/types";
import type {Invoice,CompanySettings} from "./invoices/types";
import type { StaffProfile } from "./staff/schema";
import type {
  OrderEvent,
  StatusChange,
  Aftercare,
  ManufacturerPack,
} from "./orders/hub";
import type {
  Product,
  Order,
  Measurement,
  Prescription,
  SavedItem,
  SavedPayment,
  OrderFile,
} from "./orders/model";
export type Role = "administrator" | "sales" | "operations" | "finance";
export type Staff = {
  id: string;
  full_name: string;
  role: Role;
  active: boolean;
  removed_at?: string | null;
  removed_by?: string | null;
  created_at: string;
};
export type Customer = {
  id: string;
  customer_number: number;
  delivery_address_same_as_customer?: boolean;
  first_name: string;
  last_name: string;
  email: string;
  mobile: string;
  alternative_phone: string;
  profession: string;
  job_title: string;
  gdc_number: string;
  practice_name: string;
  practice_telephone: string;
  assigned_to: string | null;
  lead_source: string | null;
  status: "Lead" | "Prospect" | "Customer" | "Inactive";
  preferred_contact: "Email" | "Phone" | "SMS" | "WhatsApp";
  notes: string;
  created_at: string;
  updated_at: string;
};
export type Address = {
  id: string;
  customer_id: string;
  kind: "Practice" | "Delivery";
  line1: string;
  line2: string;
  city: string;
  county?: string;
  postcode: string;
  country: string;
};
export type Activity = {
  id: string;
  customer_id: string;
  type: string;
  description: string;
  user_id: string;
  created_at: string;
};
export type Task = {
  order_id: string | null;
  id: string;
  customer_id: string;
  title: string;
  description: string;
  assigned_to: string;
  due_date: string;
  priority: "Low" | "Medium" | "High";
  completed: boolean;
  created_by: string;
  created_at: string;
};
export type CustomerFile = {
  id: string;
  customer_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  category: "Customer" | "Other";
  description: string;
  storage_path: string;
  internal: boolean;
  uploaded_by: string;
  created_at: string;
};
export type Duplicate = Pick<
  Customer,
  "id" | "customer_number" | "first_name" | "last_name" | "practice_name"
>;
export type ActionState = {
  error?: string;
  success?: string;
  duplicates?: Duplicate[];
};
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];
type Table<T> = {
  Row: T;
  Insert: Partial<T>;
  Update: Partial<T>;
  Relationships: [];
};
export type Database = {
  public: {
    Tables: ScanTables & {
      media_files:Table<MediaFile>;
      media_settings:Table<MediaSettings>;
      media_categories:Table<MediaCategory>;
      media_order_links:Table<{file_id:string;order_id:string;linked_by:string;created_at:string}>;
      media_events:Table<{id:string;file_id:string;customer_id:string;order_id:string|null;action:string;user_id:string;created_at:string}>;
      document_packages:Table<DocumentPackage>;
      invoices:Table<Invoice>;
      company_settings:Table<CompanySettings>;
      finance_settings: Table<{id:boolean;manufacturer_requirement:string}>;
      order_events: Table<OrderEvent>;
      order_status_history: Table<StatusChange>;
      order_aftercare: Table<Aftercare>;
      manufacturer_packs: Table<ManufacturerPack>;
      products: Table<Product>;
      orders: Table<Order>;
      measurements: Table<Measurement>;
      prescriptions: Table<Prescription>;
      order_items: Table<SavedItem>;
      payments: Table<SavedPayment>;
      order_files: Table<OrderFile>;
      users: Table<Staff>;
      staff_profiles: Table<StaffProfile>;
      password_grants: Table<{
        digest: string;
        user_id: string;
        expires_at: string;
      }>;
      customers: Table<Customer>;
      customer_addresses: Table<Address>;
      activities: Table<Activity>;
      tasks: Table<Task>;
      files: Table<CustomerFile>;
      lead_sources: Table<{ name: string; active: boolean }>;
      role_permissions: Table<{ role: Role; permission: string }>;
      audit_logs: Table<{
        id: number;
        user_id: string | null;
        action: string;
        entity_type: string;
        entity_id: string;
        created_at: string;
        previous_value: Json;
        new_value: Json;
      }>;
    };
    Views: Record<string, never>;
    Functions: {
      scan_fit_operate: { Args: { actor: string; operation: string; payload: Json }; Returns: Json };
      scan_fit_issue_client_link: { Args: { actor: string; payload: Json }; Returns: Json };
      scan_fit_client_authorize: { Args: { link_hash: string; operation: string; payload: Json }; Returns: Json };
      scan_fit_revoke_client_link: { Args: { actor: string; target: string }; Returns: undefined };
      save_product: {Args:{target:string;payload:Json};Returns:undefined};
      report_data: {Args:{filters:Json};Returns:Json};
      record_report_export: {Args:{filters:Json;format:string};Returns:undefined};
      media_config:{Args:Record<string,never>;Returns:Json};
      media_scope:{Args:{customer:string;related_order:string|null};Returns:boolean};
      search_media:{Args:{filters:Json};Returns:Json};
      reserve_media:{Args:{target:string;customer:string;related_order:string|null;details:Json};Returns:string};
      finish_media:{Args:{target:string;has_thumbnail:boolean;actor:string};Returns:undefined};
      edit_media:{Args:{target:string;details:Json};Returns:undefined};
      link_media:{Args:{target:string;related_order:string};Returns:undefined};
      media_shareable:{Args:{target:string};Returns:boolean};
      review_manufacturer:{Args:{target:string;selected:string[];instructions:string};Returns:Json};
      reserve_manufacturer:{Args:{target:string;request_id:string;selected:string[];instructions:string;expected:string};Returns:string};
      finish_manufacturer:{Args:{target:string;bytes:number;sha:string;actor:string};Returns:string};
      prepare_document_package:{Args:{target:string;related_order:string|null;customer:string;audience:string;selected:string[]};Returns:string};
      configure_media:{Args:{settings:Json};Returns:undefined};
      save_company_settings:{Args:{payload:Json;verified:boolean};Returns:undefined};
      invoice_preview:{Args:{target:string;supplied:string;pay_by:string|null;note:string};Returns:Json};
      reserve_invoice:{Args:{target:string;supplied:string;pay_by:string|null;note:string;expected:string};Returns:string};
      finalize_invoice:{Args:{target:string;actor:string;path:string;sha:string};Returns:undefined};
      cancel_invoice_draft:{Args:{target:string;reason:string};Returns:undefined};

      purge_unused_staff:{Args:{target:string;confirmed:boolean};Returns:undefined};
      remove_staff: {Args:{target:string;confirmed:boolean};Returns:undefined};
      set_manufacturing_window: {Args:{target:string;from_date:string;to_date:string;reason:string;new_order_date?:string};Returns:undefined};
      finance_operation: {Args:{target:string;operation:string;payload:Json;request_id:string};Returns:Json};
      order_financial_summary: {Args:{target:string};Returns:Json};
      customer_financial_summary: {Args:{target:string};Returns:Json};
      search_payments: {Args:{filters:Json};Returns:Json};
      configure_finance: {Args:{requirement:string};Returns:undefined};
      system_health: {Args:Record<string,never>;Returns:Json};
      staff_sales_summary: { Args: Record<string, never>; Returns: Json };
      edit_staff: {
        Args: {
          target: string;
          first_name: string;
          last_name: string;
          mobile: string;
          new_role: Role;
          is_active: boolean;
        };
        Returns: undefined;
      };
      staff_auth_event: {
        Args: { target: string; event: string };
        Returns: undefined;
      };
      consume_password_grant: { Args: { proof: string }; Returns: boolean };
      claim_auth_email: { Args: { key_hash: string }; Returns: boolean };
      operate_order: {
        Args: {
          target: string;
          operation: string;
          payload: Json;
          request_id: string;
        };
        Returns: Json;
      };
      save_order: {
        Args: {
          p_id: string;
          p_payload: Json;
          p_expected_version: number;
          p_confirm?: boolean;
        };
        Returns: Json;
      };
      register_order_file: {
        Args: {
          target: string;
          path: string;
          label: string;
          mime: string;
          bytes: number;
          expected_version: number;
        };
        Returns: Json;
      };
      remove_order_file: {
        Args: { target: string; expected_version: number };
        Returns: string;
      };
      can_read_order: { Args: { target: string }; Returns: boolean };
      has_permission: { Args: { p_permission: string }; Returns: boolean };
      update_staff: {
        Args: { target: string; new_role: Role; is_active: boolean };
        Returns: undefined;
      };
      save_customer: {
        Args: {
          payload: Json;
          addresses: Json;
          customer_id?: string;
          allow_duplicate?: boolean;
        };
        Returns: Json;
      };
      search_customers: {
        Args: {
          term?: string;
          status_filter?: string;
          assignee?: string;
          sort_key?: string;
          page_number?: number;
        };
        Returns: (Pick<
          Customer,
          | "id"
          | "customer_number"
          | "first_name"
          | "last_name"
          | "email"
          | "mobile"
          | "practice_name"
          | "status"
          | "assigned_to"
        > & { total_count: number })[];
      };
    };
    Enums: { staff_role: Role; customer_status: Customer["status"] };
    CompositeTypes: Record<string, never>;
  };
};
