CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS canals (
    canal_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    name TEXT NOT NULL,
    barangay TEXT NOT NULL,
    location_description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
    device_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    canal_id UUID NOT NULL REFERENCES canals (canal_id) ON DELETE RESTRICT,
    device_code TEXT NOT NULL UNIQUE,
    firmware_version TEXT,
    status TEXT NOT NULL DEFAULT 'offline' CHECK (
        status IN (
            'online',
            'offline',
            'maintenance'
        )
    ),
    sensor_mount_height_m NUMERIC(7, 3),
    last_seen_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS water_readings (
    reading_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
    distance_m NUMERIC(8, 4),
    water_level_m NUMERIC(8, 4),
    gate_position_pct NUMERIC(5, 2) CHECK (
        gate_position_pct BETWEEN 0 AND 100
    ),
    reading_valid BOOLEAN NOT NULL DEFAULT TRUE,
    measured_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS water_readings_device_measured_idx ON water_readings (device_id, measured_at DESC);

CREATE TABLE IF NOT EXISTS schedules (
    schedule_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    canal_id UUID NOT NULL REFERENCES canals (canal_id) ON DELETE RESTRICT,
    barangay TEXT NOT NULL,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    target_level_m NUMERIC(8, 4),
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (
        status IN (
            'scheduled',
            'active',
            'completed',
            'cancelled'
        )
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_at > start_at)
);

CREATE TABLE IF NOT EXISTS gate_commands (
    command_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    device_id UUID NOT NULL REFERENCES devices (device_id) ON DELETE RESTRICT,
    target_position_pct NUMERIC(5, 2) NOT NULL CHECK (
        target_position_pct BETWEEN 0 AND 100
    ),
    observed_position_pct NUMERIC(5, 2) CHECK (
        observed_position_pct BETWEEN 0 AND 100
    ),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN (
            'pending',
            'accepted',
            'completed',
            'rejected',
            'expired',
            'failed'
        )
    ),
    failure_reason TEXT,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS alerts (
    alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    device_id UUID NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (
        severity IN ('info', 'warning', 'critical')
    ),
    message TEXT NOT NULL,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS alerts_open_triggered_idx ON alerts (triggered_at DESC)
WHERE
    resolved_at IS NULL;
-- Additive extensions for administrator access and calibrated water-level data.
CREATE TABLE IF NOT EXISTS admins (
    admin_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    account_status TEXT NOT NULL DEFAULT 'active' CHECK (
        account_status IN ('active', 'disabled')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    admin_id UUID NOT NULL REFERENCES admins (admin_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS admin_sessions_admin_expiry_idx ON admin_sessions (admin_id, expires_at DESC);

ALTER TABLE devices
ADD COLUMN IF NOT EXISTS device_name TEXT,
ADD COLUMN IF NOT EXISTS device_type TEXT NOT NULL DEFAULT 'water-level-controller',
ADD COLUMN IF NOT EXISTS gateway_status TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (
    gateway_status IN (
        'OPEN',
        'CLOSED',
        'MOVING',
        'ERROR',
        'OFFLINE'
    )
),
ADD COLUMN IF NOT EXISTS servo_angle SMALLINT CHECK (servo_angle BETWEEN 0 AND 180),
ADD COLUMN IF NOT EXISTS control_mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK (
    control_mode IN ('AUTOMATIC', 'MANUAL')
),
ADD COLUMN IF NOT EXISTS last_communication TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE water_readings
ADD COLUMN IF NOT EXISTS raw_sensor_value INTEGER,
ADD COLUMN IF NOT EXISTS device_message_id TEXT,
ADD COLUMN IF NOT EXISTS water_level_pct NUMERIC(5, 2) CHECK (
    water_level_pct BETWEEN 0 AND 100
),
ADD COLUMN IF NOT EXISTS water_level_status TEXT CHECK (
    water_level_status IN (
        'LOW',
        'NORMAL',
        'HIGH',
        'CRITICAL',
        'UNCONFIGURED',
        'INVALID'
    )
),
ADD COLUMN IF NOT EXISTS gateway_status TEXT CHECK (
    gateway_status IN (
        'OPEN',
        'CLOSED',
        'MOVING',
        'ERROR',
        'OFFLINE'
    )
),
ADD COLUMN IF NOT EXISTS control_mode TEXT CHECK (
    control_mode IN ('AUTOMATIC', 'MANUAL')
);

CREATE TABLE IF NOT EXISTS device_level_settings (
    device_id UUID PRIMARY KEY REFERENCES devices (device_id) ON DELETE CASCADE,
    raw_at_low_level INTEGER,
    raw_at_high_level INTEGER,
    low_max_pct NUMERIC(5, 2) CHECK (low_max_pct BETWEEN 0 AND 100),
    normal_max_pct NUMERIC(5, 2) CHECK (
        normal_max_pct BETWEEN 0 AND 100
    ),
    high_max_pct NUMERIC(5, 2) CHECK (
        high_max_pct BETWEEN 0 AND 100
    ),
    automatic_open_below_pct NUMERIC(5, 2) CHECK (
        automatic_open_below_pct BETWEEN 0 AND 100
    ),
    automatic_close_above_pct NUMERIC(5, 2) CHECK (
        automatic_close_above_pct BETWEEN 0 AND 100
    ),
    updated_by UUID REFERENCES admins (admin_id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (
            low_max_pct IS NULL
            AND normal_max_pct IS NULL
            AND high_max_pct IS NULL
        )
        OR (
            low_max_pct IS NOT NULL
            AND normal_max_pct IS NOT NULL
            AND high_max_pct IS NOT NULL
            AND low_max_pct < normal_max_pct
            AND normal_max_pct < high_max_pct
        )
    ),
    CHECK (
        raw_at_low_level IS NULL
        OR raw_at_high_level IS NULL
        OR raw_at_low_level <> raw_at_high_level
    )
);

ALTER TABLE gate_commands
ADD COLUMN IF NOT EXISTS command_action TEXT CHECK (
    command_action IN ('OPEN_GATE', 'CLOSE_GATE')
),
ADD COLUMN IF NOT EXISTS control_mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK (
    control_mode IN ('AUTOMATIC', 'MANUAL')
),
ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'ADMIN' CHECK (
    trigger_source IN (
        'ADMIN',
        'AUTOMATION',
        'DEVICE'
    )
),
ADD COLUMN IF NOT EXISTS servo_angle SMALLINT CHECK (servo_angle BETWEEN 0 AND 180),
ADD COLUMN IF NOT EXISTS issued_by UUID REFERENCES admins (admin_id) ON DELETE SET NULL;

ALTER TABLE gate_commands
ADD COLUMN IF NOT EXISTS last_delivery_at TIMESTAMPTZ;

ALTER TABLE gate_commands
DROP CONSTRAINT IF EXISTS gate_commands_status_check;

ALTER TABLE gate_commands
ADD CONSTRAINT gate_commands_status_check CHECK (
    status IN (
        'pending',
        'queued',
        'sent',
        'accepted',
        'confirmed',
        'completed',
        'rejected',
        'expired',
        'failed'
    )
);

CREATE TABLE IF NOT EXISTS gateway_activity (
    activity_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
    command_id UUID REFERENCES gate_commands (command_id) ON DELETE SET NULL,
    admin_id UUID REFERENCES admins (admin_id) ON DELETE SET NULL,
    previous_status TEXT CHECK (
        previous_status IN (
            'OPEN',
            'CLOSED',
            'MOVING',
            'ERROR',
            'OFFLINE'
        )
    ),
    new_status TEXT NOT NULL CHECK (
        new_status IN (
            'OPEN',
            'CLOSED',
            'MOVING',
            'ERROR',
            'OFFLINE'
        )
    ),
    servo_angle SMALLINT CHECK (servo_angle BETWEEN 0 AND 180),
    control_mode TEXT NOT NULL CHECK (
        control_mode IN ('AUTOMATIC', 'MANUAL')
    ),
    trigger_source TEXT NOT NULL CHECK (
        trigger_source IN (
            'ADMIN',
            'AUTOMATION',
            'DEVICE'
        )
    ),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gateway_activity_device_time_idx ON gateway_activity (device_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS device_control_commands (
    control_command_id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    device_id UUID NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
    requested_mode TEXT NOT NULL CHECK (
        requested_mode IN ('AUTOMATIC', 'MANUAL')
    ),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN (
            'pending',
            'sent',
            'confirmed',
            'failed'
        )
    ),
    failure_reason TEXT,
    issued_by UUID REFERENCES admins (admin_id) ON DELETE SET NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_delivery_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS device_control_commands_pending_idx ON device_control_commands (device_id, issued_at)
WHERE
    status IN ('pending', 'sent');

CREATE TABLE IF NOT EXISTS system_events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    admin_id UUID REFERENCES admins (admin_id) ON DELETE SET NULL,
    device_id UUID REFERENCES devices (device_id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info' CHECK (
        severity IN (
            'info',
            'warning',
            'error',
            'critical'
        )
    ),
    message TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS system_events_time_idx ON system_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS water_readings_device_pct_time_idx ON water_readings (device_id, measured_at DESC)
WHERE
    water_level_pct IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS water_readings_device_message_idx ON water_readings (device_id, device_message_id)
WHERE
    device_message_id IS NOT NULL;

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS acknowledged_by UUID REFERENCES admins (admin_id) ON DELETE SET NULL;