-- 0002_api_token: 개인 접근 토큰(CR-18 C3). MCP·REST를 Bearer로 호출하는 외부 연동용. 적용 후에는 수정 금지(해시 대조, T2.1).
CREATE TABLE tf_api_token (
    token_id            INTEGER GENERATED ALWAYS AS IDENTITY,
    user_id             INTEGER      NOT NULL,
    token_nm            VARCHAR(100) NOT NULL,
    token_prefix        VARCHAR(16)  NOT NULL,
    token_hash          CHAR(64)     NOT NULL,
    expires_at          TIMESTAMP(0) NOT NULL,
    last_used_at        TIMESTAMP(0),
    last_used_ip        VARCHAR(45),
    revoked_at          TIMESTAMP(0),
    created_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by VARCHAR(50) NOT NULL, created_ip VARCHAR(45),
    updated_at TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by VARCHAR(50) NOT NULL, updated_ip VARCHAR(45),
    CONSTRAINT pk_tf_api_token PRIMARY KEY (token_id),
    CONSTRAINT uk_tf_api_token_hash UNIQUE (token_hash),
    CONSTRAINT fk_tf_api_token_user FOREIGN KEY (user_id) REFERENCES tf_user (user_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX ix_tf_api_token_user ON tf_api_token (user_id);
--> statement-breakpoint
COMMENT ON TABLE  tf_api_token IS '개인 접근 토큰(MCP·REST Bearer, CR-18). 원문은 저장하지 않고 SHA-256 해시만';
--> statement-breakpoint
COMMENT ON COLUMN tf_api_token.token_prefix IS '원문 앞부분(화면 식별용, 예 tfp_AbCd1234)';
--> statement-breakpoint
COMMENT ON COLUMN tf_api_token.token_hash IS '원문 SHA-256 16진수';
