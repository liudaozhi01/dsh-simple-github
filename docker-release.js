// Pure documentation preview: no imports, environment reads, commands or deployment.
const INPUT_KEYS=new Set(['environment','head','fingerprint','backendImage','frontendImage','uid','gid']);
const TARGETS=Object.freeze({dev:Object.freeze({backendPort:8082,frontendPort:28081}),test:Object.freeze({backendPort:8081,frontendPort:28080})});
const HEX40=/^[a-f0-9]{40}$(?![\s\S])/i,HEX64=/^[a-f0-9]{64}$(?![\s\S])/i;
// Deliberately narrower than the complete OCI grammar; no tags, variables or credentials.
const PART='[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const REPOSITORY=new RegExp(`^(?:(?:localhost|[a-z0-9]+(?:[.-][a-z0-9]+)+)(?::[1-9][0-9]{0,4})?/)?${PART}(?:/${PART})*$`);
function imageDigest(value){
 if(typeof value!=='string'||value.length>512||/[\s\x00-\x1f\x7f]/.test(value))throw new TypeError('Image must be a restricted repository@sha256 digest.');
 const parts=value.split('@sha256:');
 if(parts.length!==2||!REPOSITORY.test(parts[0])||!HEX64.test(parts[1]))throw new TypeError('Image must be a restricted repository@sha256 digest.');
 const registryPort=parts[0].split('/')[0].split(':')[1];
 if(registryPort&&Number(registryPort)>65535)throw new TypeError('Image registry port is invalid.');
 return `${parts[0]}@sha256:${parts[1].toLowerCase()}`;
}
function runtimeId(value){
 if(!Number.isSafeInteger(value)||value<=0||value>2147483647)throw new TypeError('UID and GID must be non-root positive integers (1..2147483647).');
 return value;
}

/** Return unexecuted configuration text only. Inputs never include credentials. */
export function createDockerReleasePreview(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new TypeError('Preview input must be a plain object.');
 if(Reflect.ownKeys(input).some(key=>!INPUT_KEYS.has(key)))throw new TypeError('Unknown preview input; credentials and execution options are forbidden.');
 const {environment,head,fingerprint,backendImage,frontendImage,uid,gid}=input;
 if(environment!=='dev'&&environment!=='test')throw new TypeError('Environment must be dev or test.');
 if(typeof head!=='string'||!HEX40.test(head))throw new TypeError('HEAD must be exactly 40 hexadecimal characters.');
 if(typeof fingerprint!=='string'||!HEX64.test(fingerprint))throw new TypeError('Fingerprint must be exactly 64 hexadecimal characters.');
 const backend=imageDigest(backendImage),frontend=imageDigest(frontendImage),user=`${runtimeId(uid)}:${runtimeId(gid)}`;
 const {backendPort,frontendPort}=TARGETS[environment],projectName=`xian-oa-${environment}`;
 const composeYaml=`# PREVIEW ONLY — Linux host networking; Compose >= 2.30 required.
# No published ports. Host loopback MySQL remains loopback; do not change its bind/firewall.
name: ${projectName}
services:
  backend:
    image: '${backend}'
    pull_policy: never
    network_mode: host
    user: '${user}'
    read_only: true
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777']
    restart: 'no'
    env_file:
      - path: /etc/xian-oa-${environment}/container.env
        required: true
        format: raw
    environment:
      SERVER_PORT: '${backendPort}'
      XINGLIAN_BIND_ADDRESS: '127.0.0.1'
      XINGLIAN_DEMO_AUTH_ENABLED: 'false'
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'
  frontend:
    image: '${frontend}'
    pull_policy: never
    network_mode: host
    user: '${user}'
    entrypoint: ['nginx']
    command: ['-g', 'daemon off;']
    volumes:
      - type: bind
        source: /etc/xian-oa-${environment}/nginx-container.conf
        target: /etc/nginx/nginx.conf
        read_only: true
        bind:
          create_host_path: false
    read_only: true
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777']
    restart: 'no'
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'
`;
 const backendDockerfile=`# DOCUMENTATION TEMPLATE ONLY: mutable base tag must be pinned to a reviewed digest.
FROM eclipse-temurin:21-jre
WORKDIR /app
COPY app.jar /app/app.jar
# Non-root UID:GID is mandatory in the Compose preview; do not run this template alone.
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
`;
 const frontendDockerfile=`# DOCUMENTATION TEMPLATE ONLY: mutable base tag must be pinned to a reviewed digest.
FROM nginxinc/nginx-unprivileged:stable-alpine
COPY web /usr/share/nginx/html
# Environment-specific nginx.conf is mounted read-only at runtime, never baked into the promoted image.
# Compose supplies the reviewed non-root UID:GID and read-only filesystem.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
`;
 const nginxConf=`# PREVIEW ONLY: run non-root on Linux host networking, never bind 0.0.0.0.
worker_processes auto;
pid /tmp/nginx.pid;
error_log /dev/null crit;
events { worker_connections 1024; }
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log off;
    server_tokens off;
    client_max_body_size 3m;
    client_body_temp_path /tmp/client_temp;
    proxy_temp_path /tmp/proxy_temp;
    fastcgi_temp_path /tmp/fastcgi_temp;
    uwsgi_temp_path /tmp/uwsgi_temp;
    scgi_temp_path /tmp/scgi_temp;
    server {
        listen 127.0.0.1:${frontendPort};
        server_name localhost;
        root /usr/share/nginx/html;
        location /api/ {
            proxy_pass http://127.0.0.1:${backendPort};
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
        location / {
            try_files $uri $uri/ /index.html;
        }
    }
}
`;
 const dockerignore=`# Allow only reviewed release artifacts, never source credentials or env files.
**
!app.jar
!web/
!web/**
!nginx.conf
**/.env
**/.env.*
**/*.env
**/*.pem
**/*.key
**/*.p12
**/*.pfx
**/.git
**/.git/**
**/node_modules
**/node_modules/**
`;
 const risks=[
  'Linux-only host network shares the host network namespace, not a network isolation boundary. Do not use Docker Desktop as equivalent evidence; MySQL must remain bound to host loopback without new exposure.',
  'Backend/frontend build-template base tags are mutable and NOT release locks: pin both reviewed base digests before any separately authorized build; running service images already require repository@sha256 digests.',
  'Source review found attachments/photos in MySQL BLOBs, not an uploads directory. Back up BLOBs and references consistently. Tomcat/multipart/ImageIO still need writable temporary space; /tmp limits and artifact permissions require runtime validation.',
  'SQL and Java startup runners can write data. The newer local source removed manufacturing demo creation, but this is not proof of the remote commit contents. Demo account creation must be disabled with XINGLIAN_DEMO_AUTH_ENABLED=false; audit the locked remote commit before starting. No parallel old/new backend starts; restart remains disabled.',
   'The existing /api/v1/health returns a fixed liveness response, not database readiness or completion of initialization. No business scheduler was found in reviewed Java source; external jobs were not inventoried.',
  'Frontend access/error request logging is disabled to avoid sensitive request details; backend application logging still needs independent redaction review despite bounded Docker logs.',
 ];
 const gates=[
   {id:'publication-policy',status:'pending',detail:environment==='test'?'Confirmed policy: promote the exact accepted dev image pair without rebuilding; only server-resolved display name 刘道志 may request test publication. A dev snapshot preview does not authorize test publication; delivery evidence is still required.':'Dev build provenance and operator permissions require review. No automatic test promotion is authorized.'},
  {id:'linux-host-network',status:'pending',detail:'Verify Linux Docker host networking, host loopback MySQL binding and no firewall/database exposure change.'},
  {id:'compose-version',status:'pending',detail:'Verify Docker Compose >= 2.30 supports env_file format: raw; do not fall back to interpolated credentials.'},
  {id:'credentials',status:'pending',detail:`Operator provisions /etc/xian-oa-${environment}/container.env with restrictive ownership/permissions outside the artifact; never read, return, package or pass its credential contents to this function. Review conflicting application binding/configuration overrides.`},
  {id:'image-provenance',status:'pending',detail:'Review immutable runtime image provenance against HEAD/fingerprint and pin both Dockerfile base digests; templates do not build or attest images.'},
  {id:'ports-and-cutover',status:'pending',detail:`Verify backend 127.0.0.1:${backendPort}, non-root binding configuration, and candidate frontend 127.0.0.1:${frontendPort} with no conflicts. Existing ingress is unchanged; frontend traffic has NOT been switched.`},
  {id:'persistence-review',status:'pending',detail:'Inventory real backend uploads/files/writes and approve required persistent paths, ownership, backup and recovery before defining volumes or starting read-only containers.'},
  {id:'database-startup',status:'pending',detail:'Audit actual initialization/migration behavior and obtain separate database-operation authorization before any backend start.'},
  {id:'runtime-and-health',status:'pending',detail:'Verify arbitrary UID/GID artifact readability, /tmp limits, application secret redaction, real backend/frontend health and rollback plan. No healthcheck or healthy result is fabricated; HTTP 401/403 alone is not health evidence.'},
  {id:'execution-authorization',status:'pending',detail:'Separate explicit approval is required for pull/build, writing files, start/stop, ingress cutover or rollback. This preview performs none of these actions.'},
 ];
 return {status:'preview-only',deployable:false,environment,head:head.toLowerCase(),fingerprint:fingerprint.toLowerCase(),projectName,backendPort,frontendPort,composeYaml,backendDockerfile,frontendDockerfile,nginxConf,dockerignore,risks,gates};
}
