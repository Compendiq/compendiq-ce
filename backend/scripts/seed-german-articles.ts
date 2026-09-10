import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || 'postgresql://kb_user:compendiq_dev_secret_2026@localhost:5432/kb_creator',
});

interface ArticleData {
  title: string;
  icon: string;
  summary: string;
  sections: Array<{
    heading: string;
    content: string;
    code?: { language: string; snippet: string };
    table?: { headers: string[]; rows: string[][] };
    tip?: string;
  }>;
}

interface TopicData {
  title: string;
  icon: string;
  summary: string;
  articles: ArticleData[];
  extraTopics?: string[];
}

interface SpaceData {
  key: string;
  name: string;
  icon: string;
  description: string;
  topics: TopicData[];
}

const spaces: SpaceData[] = [
  // =========================================================================
  // 1. LINUX SPACE (~38 articles organized in 6 Topic parent pages)
  // =========================================================================
  {
    key: 'LINUX',
    name: 'Linux Systemadministration & Core Engineering',
    icon: 'server',
    description: 'Umfassende Dokumentation zur Administration moderner Linux-Systeme (Kernel, Storage, Networking, Security, Performance).',
    topics: [
      {
        title: 'Kernel, Boot-Architektur & Systeminitialisierung',
        icon: 'power',
        summary: 'Grundlagen des Linux-Kernels, Initialisierungsphasen von UEFI bis systemd, Kernel-Module und Crash-Dump-Analysen.',
        articles: [
          {
            title: 'Linux Boot-Prozess: Von UEFI über GRUB2 und Initramfs zu systemd',
            icon: 'power',
            summary: 'Detaillierte Analyse der Initialisierungsphasen eines modernen Linux-Servers von Firmware bis zum User Space.',
            sections: [
              {
                heading: 'Phasen des Boot-Vorgangs',
                content: 'Der Linux-Startvorgang gliedert sich in vier Hauptphasen: 1. Firmware/UEFI Initialisierung & POST, 2. Bootloader (GRUB2) Ausführung, 3. Kernel-Laden & Initial RAM Disk (initramfs/initrd), 4. Übergabe an das Init-System (systemd Target multi-user.target bzw. graphical.target).'
              },
              {
                heading: 'Initramfs Untersuchung & Debugging',
                content: 'Das Initramfs stellt essentielle Treiber bereit, um das eigentliche Root-Dateisystem einzubinden (z. B. RAID, LVM, NVMe oder verschlüsselte LUKS-Container).',
                code: {
                  language: 'bash',
                  snippet: '# Initramfs Inhalt inspizieren\nlsinitrd /boot/initramfs-$(uname -r).img | grep -E "systemd|lvm|crypto"\n\n# Neues Initramfs mit Dracut generieren\nsudo dracut --force --verbose'
                }
              },
              {
                heading: 'Boot-Performance Analyse mit systemd-analyze',
                content: 'Mit integrierten systemd-Tools kann die Startzeit einzelner Units präzise profiliert werden.',
                code: {
                  language: 'bash',
                  snippet: '# Gesamtübersicht der Bootzeit\nsystemd-analyze time\n\n# Langsamste Units auflisten\nsystemd-analyze blame\n\n# SVG-Diagramm des kritischen Pfads exportieren\nsystemd-analyze plot > /tmp/boot-analysis.svg'
                },
                tip: 'Verzögerungen entstehen häufig durch blockierende Netzwerk-Mounts oder fehlerhafte Entropy-Generierung beim Start.'
              }
            ]
          },
          {
            title: 'systemd Service- und Timer-Management für Enterprise Workloads',
            icon: 'clock',
            summary: 'Konfiguration robuster systemd Services, Watchdogs, Sandboxing-Direktiven und cron-Ersatz durch Timer Units.',
            sections: [
              {
                heading: 'Aufbau einer gehärteten Unit-Datei',
                content: 'Moderne Service-Units sollten zwingend Sicherheitsbeschränkungen wie ProtectSystem, ProtectHome und NoNewPrivileges nutzen.',
                code: {
                  language: 'ini',
                  snippet: '[Unit]\nDescription=High-Performance API Backend Service\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=notify\nExecStart=/usr/local/bin/api-server\nRestart=always\nRestartSec=5s\nWatchdogSec=10s\n\n# Sandboxing & Hardening\nProtectSystem=strict\nProtectHome=true\nNoNewPrivileges=true\nPrivateTmp=true\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n\n[Install]\nWantedBy=multi-user.target'
                }
              },
              {
                heading: 'systemd Timer als moderner Cron-Ersatz',
                content: 'Timer bieten gegenüber crontab Vorteile wie akkurate Protokollierung im Journal, Abhängigkeitsprüfung und Persistenz nach Ausfällen (Persistent=true).',
                code: {
                  language: 'ini',
                  snippet: '[Unit]\nDescription=Daily Database Maintenance Timer\n\n[Timer]\nOnCalendar=*-*-* 03:30:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target'
                }
              }
            ]
          },
          {
            title: 'cgroups v2 & Linux Namespaces: Die Fundamente moderner Container',
            icon: 'box',
            summary: 'Tiefgehende Analyse von Control Groups v2 und den 8 Linux Namespaces zur Isolation von Prozessen.',
            sections: [
              {
                heading: 'Die 8 Linux Kernel Namespaces',
                content: 'Namespaces isolieren Systemressourcen pro Prozessgruppe: PID (Prozess-IDs), NET (Netzwerk-Interfaces & Routing), MNT (Mount-Points), IPC (Inter-Process Comm), UTS (Hostname), USER (UID/GID Mapping), CGROUP (Cgroup Hierarchie) und TIME.'
              },
              {
                heading: 'Hands-on: Isolierter Prozess mit unshare erstellen',
                content: 'Mit dem Linux Utility `unshare` lässt sich ein Container-ähnlicher isolierter Raum ohne Docker erzeugen.',
                code: {
                  language: 'bash',
                  snippet: '# Neuer UTS, PID und Mount Namespace\nsudo unshare --uts --pid --mount --fork /bin/bash\n\n# Hostname ändern (nur im Namespace sichtbar)\nhostname container-node-01\nhostname'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'Linux Kernel Modul-Management (lsmod, modprobe, dmesg und DKMS)',
          'Linux Kernel Crash Dump Analyse mit Kdump und Crash-Utility',
          'Linux Kernel Live-Patching mit kpatch und Canonical Livepatch',
          'Linux cgroups v2 Memory Limits und Swappiness Steuerung',
          'Udev Rules und dynamisches Device-Management im Linux Kernel'
        ]
      },
      {
        title: 'Storage, Dateisysteme & Block-Layer',
        icon: 'hard-drive',
        summary: 'Dateisysteme (Ext4, XFS, Btrfs, ZFS), LVM Logical Volume Management, Multipathing und Disaster Recovery.',
        articles: [
          {
            title: 'Dateisysteme im Vergleich: Ext4, XFS, Btrfs und ZFS auf Linux',
            icon: 'hard-drive',
            summary: 'Architektur- und Leistungsunterschiede gängiger Linux-Dateisysteme für Datenbanken, Container und Archivspeicher.',
            sections: [
              {
                heading: 'Vergleichsmatrix der Dateisysteme',
                content: 'Die Wahl des Dateisystems beeinflusst Schreibdurchsatz, Snapshot-Fähigkeiten und Datenintegrität.',
                table: {
                  headers: ['Dateisystem', 'Max. Partitionsgröße', 'Copy-on-Write (CoW)', 'Checksummen', 'Empfohlener Einsatzbereich'],
                  rows: [
                    ['Ext4', '1 EiB', 'Nein', 'Nur Metadaten', 'Standard Linux OS, Allround'],
                    ['XFS', '8 EiB', 'Nein (Reflink optional)', 'Metadaten v5', 'Enterprise Datenbanken, Big Data'],
                    ['Btrfs', '16 EiB', 'Ja', 'Daten + Metadaten', 'Snapshots, Container-Storage'],
                    ['ZFS', '256 ZiB', 'Ja', 'Daten + Metadaten (Merkle Tree)', 'Massenspeicher, High Availability']
                  ]
                }
              },
              {
                heading: 'Dateisystem-Optimierung für PostgreSQL/MySQL auf XFS',
                content: 'Optimierte Mount-Optionen wie noatime und nodiratime reduzieren unnötige Schreibzyklen erheblich.',
                code: {
                  language: 'bash',
                  snippet: '# Formatierung mit Reflink-Unterstützung\nsudo mkfs.xfs -m crc=1,reflink=1 /dev/sdb1\n\n# fstab Mount-Optionen\nUUID=xxxx-xxxx /var/lib/postgresql xfs noatime,nodiratime,logbufs=8,logbsize=256k 0 2'
                }
              }
            ]
          },
          {
            title: 'LVM (Logical Volume Manager): PV, VG, LV und Thin Provisioning',
            icon: 'layers',
            summary: 'Praxisleitfaden zur dynamischen Speicherverwaltung, Online-Vergrößerung und Snapshot-Erstellung unter Linux.',
            sections: [
              {
                heading: 'Grundlegende LVM-Architektur',
                content: 'LVM trennt physische Blockgeräte von virtuellen Partitionen über drei Abstraktionsebenen: Physical Volumes (PV), Volume Groups (VG) und Logical Volumes (LV).'
              },
              {
                heading: 'Workflow: Online-Erweiterung eines Dateisystems',
                content: 'Logical Volumes und darunterliegende Dateisysteme können unterbrechungsfrei im laufenden Betrieb vergrößert werden.',
                code: {
                  language: 'bash',
                  snippet: '# 1. PV vergrößern nach Block-Device-Resize\nsudo pvresize /dev/sda3\n\n# 2. LV um 50GB erweitern inklusive XFS/Ext4 Filesystem\nsudo lvextend -L +50G --resizefs /dev/vg_system/lv_data\n\n# 3. Status überprüfen\nsudo lvs -o lv_name,lv_size,seg_pe_ranges'
                }
              }
            ]
          },
          {
            title: 'Linux Storage Multipathing & iSCSI Initiator Enterprise Setup',
            icon: 'database',
            summary: 'Konfiguration ausfallsicherer SAN-Verbindungen über iSCSI und Device Mapper Multipath.',
            sections: [
              {
                heading: 'Multipath Daemon Konfiguration',
                content: 'Zusammenfassung redundanter Fiber-Channel- oder iSCSI-Pfade zu einem konsistenten Blockgerät.',
                code: {
                  language: 'bash',
                  snippet: '# Multipath Status anzeigen\nsudo multipath -ll\n\n# iSCSI Targets entdecken und einbinden\nsudo iscsiadm -m discovery -t sendtargets -p 192.168.100.10\nsudo iscsiadm -m node --loginall=all'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'Linux Dateisystem-Hierarchie (FHS) und Virtual File System (VFS)',
          'POSIX Access Control Lists (ACLs) und erweiterte Datei-Attribute (chattr)',
          'Linux In-Memory Dateisysteme: tmpfs, ramfs und HugeTLBfs',
          'Linux Storage Enclosure Management (SES) und NVMe-over-Fabrics (NVMe-oF)',
          'Backups und Disaster Recovery mit BorgBackup und Restic'
        ]
      },
      {
        title: 'Netzwerk, Routing & Firewalling',
        icon: 'network',
        summary: 'Linux Networking Stack, nftables/iptables, TCP/IP Performance Tuning, DNS Resolution und VLAN Tagging.',
        articles: [
          {
            title: 'Linux Networking: iptables, nftables und das iproute2 Framework',
            icon: 'network',
            summary: 'Paketfilterung, NAT-Regeln, Routing-Tabellen und moderne Firewall-Architekturen mit nftables.',
            sections: [
              {
                heading: 'Evolution von iptables zu nftables',
                content: 'nftables ersetzt das veraltete iptables/ip6tables/arptables Framework durch eine einheitliche Syntax und deutlich höhere Performance dank In-Kernel Bytecode.'
              },
              {
                heading: 'Beispiel: Produktionsreife nftables-Konfiguration',
                content: 'Moderne Stateful-Firewall-Konfiguration mit Rate-Limiting für SSH und Portfreigaben.',
                code: {
                  language: 'text',
                  snippet: 'table inet filter {\n    chain input {\n        type filter hook input priority 0; policy drop;\n        \n        # Loopback & Established Connections\n        iif "lo" accept\n        ct state established,related accept\n        ct state invalid drop\n        \n        # Rate-limited SSH (max 5 Versuche/Minute)\n        tcp dport 22 ct state new meter ssh-meter { ip saddr limit rate 5/minute } accept\n        \n        # Web-Ports\n        tcp dport { 80, 443 } accept\n    }\n}'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'Firewalld und UFW im Vergleich: Enterprise Firewall Strategien',
          'TCP/IP Stack Tuning: BBR Congestion Control, TIME_WAIT und Syn-Cookies',
          'DNS Resolution in Linux: systemd-resolved, /etc/resolv.conf und nsswitch',
          'Network Bonding, LACP und 802.1Q VLAN Tagging unter Linux',
          'Präzise Zeitsynchronisation mit Chrony und PTP (Precision Time Protocol)'
        ]
      },
      {
        title: 'Sicherheit, Hardening & Access Control',
        icon: 'shield',
        summary: 'Enterprise Server-Hardening, SELinux/AppArmor MAC, SSH-Härtung, PAM und Linux Audit-Frameworks.',
        articles: [
          {
            title: 'SSH Hardening: Ed25519 Keys, FIDO2 Hardware-Tokens & Certificate Authority',
            icon: 'lock',
            summary: 'Maximale Absicherung des SSH-Zugangs auf Enterprise-Servern gegen Brute-Force und Credential Theft.',
            sections: [
              {
                heading: 'sshd_config Härtungsrichtlinien',
                content: 'Passwort-Authentifizierung und Root-Login müssen deaktiviert werden. Als Cipher-Suites kommen nur moderne Kurven zum Einsatz.',
                code: {
                  language: 'ini',
                  snippet: 'Port 22\nPermitRootLogin no\nPasswordAuthentication no\nPubkeyAuthentication yes\nAuthenticationMethods publickey\n\n# KEX & Ciphers (BSI/NIST konform)\nKexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org\nCiphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com\nMACs hmac-sha2-512-etm@openssh.com\n\nMaxAuthTries 3\nClientAliveInterval 300\nClientAliveCountMax 2'
                }
              }
            ]
          },
          {
            title: 'SELinux in der Praxis: Kontext-Labels, Booleans und Troubleshooting',
            icon: 'shield',
            summary: 'Verwaltung von Mandatory Access Control (MAC) unter RHEL, Rocky Linux und Fedora.',
            sections: [
              {
                heading: 'SELinux Kernkomponenten',
                content: 'SELinux ordnet jedem Prozess und jeder Datei einen Sicherheitskontext zu: user:role:type:level. Die wichtigste Komponente für Administratoren ist der type (z. B. httpd_sys_content_t).'
              },
              {
                heading: 'Fehlerbehebung mit audit2why und semanage',
                content: 'Verweigerte Zugriffe (AVC Denials) aus /var/log/audit/audit.log gezielt analysieren und beheben.',
                code: {
                  language: 'bash',
                  snippet: '# Letzte SELinux-Verweigerungen analysieren\nsudo ausearch -m AVC,USER_AVC -ts recent | audit2why\n\n# Verzeichnis rekursiv korrekt labeln\nsudo semanage fcontext -a -t httpd_sys_content_t "/custom/web(/.*)?"\nsudo restorecon -Rv /custom/web'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'AppArmor Profile-Erstellung und Security Policy Enforcement',
          'Auditd: Umfassendes Linux Security Auditing und Compliance Monitoring',
          'Pluggable Authentication Modules (PAM) und Multi-Faktor Authentifizierung',
          'Linux Server Hardening Checklist nach CIS Benchmark Richtlinien'
        ]
      },
      {
        title: 'Performance Tuning, Tracing & Diagnostik',
        icon: 'activity',
        summary: 'Linux Speichermanagement, Kernel sysctl Tuning, eBPF Tracing, I/O-Profiling und Hardware-Diagnostik.',
        articles: [
          {
            title: 'Linux Performance Tuning: Kernel-Parameter via sysctl optimieren',
            icon: 'sliders',
            summary: 'Wichtige Kernel-Parameter für High-Throughput Web- und Datenbankserver.',
            sections: [
              {
                heading: 'Produktionskonfiguration in /etc/sysctl.d/99-performance.conf',
                content: 'Anpassung von TCP-Puffern, Somaxconn, File-Descriptors und Swappiness für High-Load Server.',
                code: {
                  language: 'ini',
                  snippet: '# TCP Performance\nnet.core.somaxconn = 65535\nnet.ipv4.tcp_max_syn_backlog = 8192\nnet.ipv4.tcp_congestion_control = bbr\n\n# Virtual Memory\nvm.swappiness = 10\nvm.vfs_cache_pressure = 50\n\n# Max Open Files\nfs.file-max = 2097152'
                }
              }
            ]
          },
          {
            title: 'Linux Memory Management: Page Cache, Swap, HugePages & OOM Killer',
            icon: 'cpu',
            summary: 'Verständnis des Linux Speichermanagements, Vermeidung von OOM-Kills und Optimierung des Page Caches.',
            sections: [
              {
                heading: 'Arbeitsweise des Linux Page Caches',
                content: 'Linux allokiert freien Arbeitsspeicher automatisch für den Page Cache zur Beschleunigung von Dateizugriffen. Bei Speicherbedarf wird Cache transparent freigegeben.'
              },
              {
                heading: 'OOM Killer Scoring & Schutz wichtiger Prozesse',
                content: 'Der Out-Of-Memory (OOM) Killer wählt bei Speichermangel Prozesse anhand ihres oom_score aus.',
                code: {
                  language: 'bash',
                  snippet: '# OOM Score eines Prozesses einsehen (0 - 1000)\ncat /proc/<PID>/oom_score\n\n# Prozess vor OOM Killer schützen (-1000 = immun)\necho -1000 | sudo tee /proc/<PID>/oom_score_adj'
                }
              }
            ]
          },
          {
            title: 'eBPF und BCC-Tools zur Kernel-Diagnose und Performance-Analyse',
            icon: 'activity',
            summary: 'Echtzeit-Tracing und Profiling des Linux Kernels ohne Kernelmodule oder Code-Änderungen.',
            sections: [
              {
                heading: 'Was ist eBPF?',
                content: 'Extended Berkeley Packet Filter (eBPF) ermöglicht das sichere Ausführen von Sandboxed Bytecode direkt im Linux Kernel bei Systemaufrufen, Netzwerkereignissen oder Tracepoints.'
              },
              {
                heading: 'Wichtige BCC und bpftrace Diagnosetools',
                content: 'Mit Tools wie execsnoop, opensnoop und biolatency können Systemengpässe in Millisekunden aufgedeckt werden.',
                code: {
                  language: 'bash',
                  snippet: '# Laufende Prozess-Starts überwachen\nsudo execsnoop-bpfcc\n\n# I/O Latenzverteilung der Festplatten als Histogramm messen\nsudo biolatency-bpfcc 1 10\n\n# Top-Funktionen im Kernel-Kontext tracen\nsudo profile-bpfcc -F 99 10'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'I/O Performance Analyse mit iostat, iotop, fio und Block-Layer Tuning',
          'Prozess-Debugging und Tracing mit strace, ltrace, gdb und perf',
          'Hardware-Diagnose und Hardware-Health (dmidecode, lspci, smartctl)'
        ]
      },
      {
        title: 'Administration, Automatisierung & High Availability',
        icon: 'sliders',
        summary: 'Log-Management, Paketverwaltung, HA-Clustering (Pacemaker/Corosync), Cloud-Init und Bash-Automatisierung.',
        articles: [],
        extraTopics: [
          'Linux Log-Management mit systemd-journald, rsyslog und Logrotate',
          'Linux Package Management und Enterprise Repositories (APT, DNF, RPM)',
          'High Availability Clustering mit Pacemaker, Corosync und STONITH',
          'Automatisierte Linux Provisionierung mit Cloud-Init und PXE Boot',
          'Shell Scripting Best Practices: Bash Strict Mode (set -euo pipefail) und Shellcheck'
        ]
      }
    ]
  },

  // =========================================================================
  // 2. DOCKER SPACE (~38 articles organized in 5 Topic parent pages)
  // =========================================================================
  {
    key: 'DOCKER',
    name: 'Docker & Container-Technologien',
    icon: 'box',
    description: 'Best Practices für Docker, Multi-Stage Builds, Security Hardening, Container Networking und Registry-Infrastruktur.',
    topics: [
      {
        title: 'Container Engine, Runtime & Architektur',
        icon: 'cpu',
        summary: 'Architektur des OCI-Ökosystems, containerd, runc, Daemon-Hardening, Rootless Docker und CLI-Alternativen.',
        articles: [
          {
            title: 'Docker Architektur & Container Runtime: containerd, runc und Shim',
            icon: 'cpu',
            summary: 'Das OCI-Ökosystem und der Ablauf vom Docker CLI-Kommando bis zum Start des isolierten Linux-Prozesses.',
            sections: [
              {
                heading: 'Die Komponenten der Container-Runtime',
                content: 'Der Docker Daemon (dockerd) interagiert über gRPC mit containerd, welches wiederum über containerd-shim den OCI-Referenz-Runner runc instruiert, Linux Namespaces und Cgroups zu initialisieren.'
              },
              {
                heading: 'Container-Prozesse auf dem Host identifizieren',
                content: 'Container sind reguläre Linux-Prozesse auf dem Host-System mit isolierten Kernel-Sichten.',
                code: {
                  language: 'bash',
                  snippet: '# PID des Containers auf dem Host finden\nDOCKER_PID=$(docker inspect --format "{{.State.Pid}}" my-container)\n\n# Namespaces des Prozesses inspizieren\nls -l /proc/$DOCKER_PID/ns\n\n# In die Namespaces des Containers einklinken ohne docker exec\nsudo nsenter --target $DOCKER_PID --mount --net --pid /bin/sh'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'Docker Daemon Konfiguration und Hardening (/etc/docker/daemon.json)',
          'Docker Rootless Daemon Setup und User-Namespace Mapping',
          'Docker Container Init-Systeme: Tini, Dumb-Init und PID 1 Zombie Reaping',
          'Docker Live-Restore Feature zur Vermeidung von Container-Downtime',
          'Docker Desktop vs Podman vs Finch: Die Container CLI Alternativen'
        ]
      },
      {
        title: 'Image Building, BuildKit & Optimierung',
        icon: 'file-code',
        summary: 'Multi-Stage Dockerfiles, BuildKit Caching, Secret Injektion, Multi-Architektur Builds und Distroless Images.',
        articles: [
          {
            title: 'Dockerfile Best Practices & Multi-Stage Builds für minimale Images',
            icon: 'file-code',
            summary: 'Schritt-für-Schritt-Anleitung zur Reduzierung von Image-Größen von 1.5 GB auf unter 50 MB.',
            sections: [
              {
                heading: 'Multi-Stage Build Pattern für Node.js / TypeScript',
                content: 'Kompilier-Werkzeuge und Dev-Dependencies verbleiben in der Build-Stage; das finale Runtime-Image enthält nur produktive Artefakte.',
                code: {
                  language: 'dockerfile',
                  snippet: '# 1. Build Stage\nFROM node:22-alpine AS builder\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\n\n# 2. Production Runtime Stage\nFROM node:22-alpine AS runner\nWORKDIR /app\nENV NODE_ENV=production\nCOPY package*.json ./\nRUN npm ci --omit=dev && npm cache clean --force\nCOPY --from=builder /app/dist ./dist\n\nUSER node\nEXPOSE 3000\nCMD ["node", "dist/index.js"]'
                }
              }
            ]
          },
          {
            title: 'Docker BuildKit: Cache-Mounts, Build-Secrets und SSH-Forwarding',
            icon: 'zap',
            summary: 'Beschleunigung von Container-Builds und sichere Übergabe von Credentials ohne Image-Leaks.',
            sections: [
              {
                heading: 'Sichere Secret Injektion beim Build',
                content: 'Niemals API-Keys über ARG übergeben! Mit --mount=type=secret werden sensible Daten temporär im Build-Schritt eingebunden.',
                code: {
                  language: 'dockerfile',
                  snippet: '# syntax=docker/dockerfile:1.4\nFROM alpine:3.20\nRUN --mount=type=secret,id=npmrc,target=/root/.npmrc \\\n    npm install private-package'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'Secret Handling in Docker Builds: BuildKit Secrets vs ENV Variablen',
          'Multi-Architektur Container Builds mit Docker Buildx (AMD64 und ARM64)',
          'Optimierung von Docker Image Größen mit Distroless und Scratch',
          'Distroless Images für Node.js, Go und Python Anwendungen',
          'Erstellung ultra-schlanker Go und Rust Microservice Container Images',
          'Docker-in-Docker (DinD) vs Docker-out-of-Docker (DooD) in CI/CD Pipelines'
        ]
      },
      {
        title: 'Container Security & Supply Chain',
        icon: 'shield-check',
        summary: 'Rootless Container, Linux Capabilities, Seccomp/AppArmor Profile, Schwachstellenscans und Image-Signierung.',
        articles: [
          {
            title: 'Docker Container Security: Rootless Mode, Capabilities & Seccomp',
            icon: 'shield-check',
            summary: 'Härtung von Containern gegen Container Breakouts und Privilege Escalation Angriffe.',
            sections: [
              {
                heading: 'Prinzip der geringsten Rechte (Least Privilege)',
                content: 'Container dürfen niemals als Root laufen. Mit cap-drop=ALL werden alle Linux Kernel-Capabilities entzogen und nur zwingend notwendige selektiv freigeschaltet.',
                code: {
                  language: 'yaml',
                  snippet: 'services:\n  backend:\n    image: my-secure-app:1.0\n    user: "10001:10001"\n    read_only: true\n    security_opt:\n      - no-new-privileges:true\n      - seccomp=/etc/docker/seccomp-strict.json\n    cap_drop:\n      - ALL\n    cap_add:\n      - NET_BIND_SERVICE\n    tmpfs:\n      - /tmp:rw,noexec,nosuid,size=64m'
                }
              }
            ]
          },
          {
            title: 'Container Image Scanning in CI/CD mit Trivy und Grype',
            icon: 'search',
            summary: 'Automatisierte Erkennung von CVE-Schwachstellen und Fehlkonfigurationen in Docker Images.',
            sections: [
              {
                heading: 'Trivy Scan Pipeline Integration',
                content: 'Automatische Blockierung von Builds bei Funden von CRITICAL Schwachstellen.',
                code: {
                  language: 'bash',
                  snippet: '# Image auf bekannte Sicherheitslücken scannen\ntrivy image --severity HIGH,CRITICAL --exit-code 1 my-app:latest'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'Syscall Filtering mit Seccomp Profilen für Docker Container',
          'AppArmor und SELinux Profile für Docker Container Workloads',
          'Container Capabilities Fine-Tuning: CAP_NET_ADMIN vs CAP_SYS_ADMIN',
          'Docker Content Trust (DCT) und Image-Signierung mit Notary',
          'Docker CIS Security Benchmark: Automatisierte Compliance Audits',
          'Container Image Provenance und SLSA Level Verification'
        ]
      },
      {
        title: 'Networking, Storage & Registries',
        icon: 'network',
        summary: 'Docker Overlay2 Storage-Treiber, Bridge/Host/Overlay Netzwerke, DNS Service Discovery und Registry Caching.',
        articles: [
          {
            title: 'Docker Storage Driver: Overlay2 Architektur & Performance',
            icon: 'hard-drive',
            summary: 'Funktionsweise des Overlay2 Union-Dateisystems, Lowerdir, Upperdir und Merged Layers.',
            sections: [
              {
                heading: 'Wie Overlay2 funktioniert',
                content: 'Overlay2 schichtet Read-Only Image Layers (lowerdir) und den beschreibbaren Container Layer (upperdir) zu einer gemeinsamen Sicht (merged) zusammen.'
              }
            ]
          },
          {
            title: 'Docker Networking: Bridge, Host, Overlay und Macvlan im Vergleich',
            icon: 'network',
            summary: 'Netzwerktopologien in Docker, iptables NAT-Forwarding und DNS Service Discovery.',
            sections: [
              {
                heading: 'Netzwerkmodi im Detail',
                content: 'Standardmäßig erstellt Docker ein isoliertes Bridge-Netzwerk mit privatem Subnetz (172.17.0.0/16). Benutzerdefinierte User-Defined Bridges bieten integrierte DNS-Namensauflösung.'
              }
            ]
          }
        ],
        extraTopics: [
          'Docker DNS Resolution und Container-zu-Container Service Discovery',
          'Backup und Migration von Docker Named Volumes und Bind Mounts',
          'Container Registry Mirroring und Pull-Through Caching',
          'Docker Image Pruning, Garbage Collection und Disk Space Management'
        ]
      },
      {
        title: 'Operations, Monitoring & Orchestrierung',
        icon: 'activity',
        summary: 'Docker Compose v2, Healthchecks, Ressourcenlimits (CPU/Memory), Logging-Treiber und Container-Debugging.',
        articles: [],
        extraTopics: [
          'Docker Compose v2 Profiles, Multi-Environment Files und Interpolation',
          'Docker Healthchecks, Restart Policies und Self-Healing Strategien',
          'Docker Resource Constraints: CPU Quotas, Memory Limits und OOMScoreAdj',
          'Graceful Container Shutdown: SIGTERM Handling und Stop Grace Periods',
          'Container Logging Best Practices: JSON-File, Fluentd, Loki und Splunk',
          'Monitoring von Docker Containern mit cAdvisor und Prometheus Exporter',
          'Debugging laufender Container mit docker exec, nsenter und crictl',
          'Docker Contexts und Remote Daemon Verwaltung über sichere TLS/SSH Sockets'
        ]
      }
    ]
  },

  // =========================================================================
  // 3. KUBERNETES SPACE (~38 articles organized in 6 Topic parent pages)
  // =========================================================================
  {
    key: 'K8S',
    name: 'Kubernetes Platform & Orchestrierung',
    icon: 'layers',
    description: 'Architektur, Deployment-Patterns, Networking, CNI, CRDs, Storage und Security für Kubernetes Cluster.',
    topics: [
      {
        title: 'Control Plane, Architektur & Core Components',
        icon: 'cpu',
        summary: 'Kubernetes Control Plane Komponenten (API Server, ETCD, Controller), Kubelet, CRDs und Cluster-Upgrades.',
        articles: [
          {
            title: 'Kubernetes Control Plane Architektur: API Server, ETCD & Controller',
            icon: 'cpu',
            summary: 'Das Zusammenspiel der Kernkomponenten von Kubernetes und die declarative State Reconciliation.',
            sections: [
              {
                heading: 'Die vier Säulen der Control Plane',
                content: '1. kube-apiserver: Zentraler REST-Endpunkt & Validierungsinstanz. 2. etcd: Konsistenter Key-Value Speicher für Cluster-Zustände. 3. kube-scheduler: Zuweisung von Pods zu Nodes. 4. kube-controller-manager: Führt Control Loops aus (Node, ReplicaSet, EndpointSlice Controller).'
              },
              {
                heading: 'ETCD Backup & Snapshotting',
                content: 'Regelmäßige Snapshots des ETCD sind Voraussetzung für Disaster Recovery.',
                code: {
                  language: 'bash',
                  snippet: '# ETCD Snapshot erstellen\nsudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \\\n  --cacert=/etc/kubernetes/pki/etcd/ca.crt \\\n  --cert=/etc/kubernetes/pki/etcd/server.crt \\\n  --key=/etc/kubernetes/pki/etcd/server.key \\\n  snapshot save /var/backups/etcd-snapshot-$(date +%F).db'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'Kubelet Architektur, Node Eviction Policies und Image Garbage Collection',
          'Custom Resource Definitions (CRDs) und das Kubernetes Operator Pattern',
          'Kubernetes Cluster Upgrades ohne Downtime mit kubeadm und Node Draining',
          'Kubernetes Disaster Recovery und Cluster-Backups mit Velero',
          'Kubernetes Multi-Cluster Management mit Cluster API und Cilium ClusterMesh'
        ]
      },
      {
        title: 'Workloads, Pod Lifecycle & Scheduling',
        icon: 'layers',
        summary: 'Pod Lifecycle, Probes, Deployments, StatefulSets, DaemonSets, Node-Affinity und Workload-Debugging.',
        articles: [
          {
            title: 'Kubernetes Pod Lifecycle, Probes und Graceful Shutdown',
            icon: 'heart-pulse',
            summary: 'Startup-, Liveness- und Readiness-Probes sowie Vermeidung von 502 Fehlern beim Rolling Update.',
            sections: [
              {
                heading: 'Die drei Probe-Typen',
                content: 'Startup Probe (schützt lang startende Apps), Liveness Probe (startet abgestürzte Container neu), Readiness Probe (steuert Traffic-Zuleitung über Service-Endpunkte).'
              },
              {
                heading: 'Best-Practice Probe & preStop Hook Konfiguration',
                content: 'Der preStop Hook gibt dem Upstream-Ingress Zeit, Routing-Tabellen zu aktualisieren, bevor SIGTERM gesendet wird.',
                code: {
                  language: 'yaml',
                  snippet: 'spec:\n  containers:\n  - name: web-api\n    image: api:v2.1\n    lifecycle:\n      preStop:\n        exec:\n          command: ["/bin/sh", "-c", "sleep 10"]\n    startupProbe:\n      httpGet:\n        path: /healthz/startup\n        port: 8080\n      failureThreshold: 30\n      periodSeconds: 2\n    readinessProbe:\n      httpGet:\n        path: /healthz/ready\n        port: 8080\n      periodSeconds: 5\n    livenessProbe:\n      httpGet:\n        path: /healthz/live\n        port: 8080\n      periodSeconds: 10'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'Kubernetes Deployments, ReplicaSets und Zero-Downtime Rolling Updates',
          'StatefulSets, PersistentVolumeClaims und Headless Services für Datenbanken',
          'DaemonSets: Verwaltung Node-lokaler Agenten für Logging und Monitoring',
          'ConfigMaps und Secrets: Injection via Environment vs Volume Mounts',
          'Node Scheduling: NodeSelector, NodeAffinity, Taints und Tolerations',
          'Topology Spread Constraints und Pod Anti-Affinity für Hochverfügbarkeit',
          'Debugging Kubernetes Workloads: Ephemeral Containers und kubectl debug'
        ]
      },
      {
        title: 'Networking, CNI, Ingress & Service Mesh',
        icon: 'network',
        summary: 'Cilium eBPF CNI, Services, Ingress Controller, Gateway API, Network Policies und Service Mesh (Istio/Linkerd).',
        articles: [
          {
            title: 'Cilium eBPF CNI: Kernel Routing, Hubble Observability & L7 Policies',
            icon: 'activity',
            summary: 'Modernes Kubernetes Networking ohne iptables-Overhead mit eBPF-gestützter Security.',
            sections: [
              {
                heading: 'Warum Cilium iptables überlegen ist',
                content: 'Cilium ersetzt O(N) iptables Lookups durch O(1) eBPF BPF-Maps direkt am Linux Socket Layer und ermöglicht transparente mTLS-Verschlüsselung mit WireGuard/IPsec.'
              },
              {
                heading: 'Layer 7 Cilium Network Policy Beispiel',
                content: 'Granulare Steuerung von HTTP-Methoden und Pfaden zwischen Pods.',
                code: {
                  language: 'yaml',
                  snippet: 'apiVersion: "cilium.io/v2"\nkind: CiliumNetworkPolicy\nmetadata:\n  name: secure-backend-policy\nspec:\n  endpointSelector:\n    matchLabels:\n      app: backend-api\n  ingress:\n  - fromEndpoints:\n    - matchLabels:\n        app: frontend\n    toPorts:\n    - ports:\n      - port: "8080"\n        protocol: TCP\n      rules:\n        http:\n        - method: GET\n          path: "/api/v1/articles.*"'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'Kubernetes Services: ClusterIP, NodePort, LoadBalancer und ExternalName',
          'Ingress Controller (NGINX, Traefik) und Ingress Routing Regeln',
          'Kubernetes Gateway API: Die moderne Evolution von Ingress Controllern',
          'Kubernetes Network Policies: Pod-Isolation und Microsegmentation',
          'Service Mesh Deep Dive: Istio vs Linkerd (mTLS, Traffic Management, Tracing)'
        ]
      },
      {
        title: 'Security, RBAC, Multi-Tenancy & Governance',
        icon: 'shield-check',
        summary: 'RBAC Rollen, Pod Security Standards (PSS/PSA), Admission Webhooks, Policy-as-Code (Kyverno/OPA) und CIS Härtung.',
        articles: [
          {
            title: 'Kubernetes RBAC: Rollen, ClusterRollen und Least-Privilege Zugriff',
            icon: 'lock',
            summary: 'Berechtigungskonzept in Kubernetes mit ServiceAccounts, Groups und RoleBindings.',
            sections: [
              {
                heading: 'Sicherheitsprinzipien für ServiceAccounts',
                content: 'Standard-ServiceAccounts sollten niemals automatische Token-Mounts (automountServiceAccountToken: false) erhalten, wenn kein API-Zugriff benötigt wird.'
              }
            ]
          }
        ],
        extraTopics: [
          'Pod Security Standards (PSS) und Pod Security Admission (PSA) Enforcement',
          'Admission Controllers: Validating und Mutating Webhooks im Kubernetes Cluster',
          'Policy-as-Code im Cluster mit Kyverno und Open Policy Agent (OPA/Gatekeeper)',
          'LimitRanges und ResourceQuotas zur Multi-Tenancy Mandantentrennung',
          'Multi-Tenancy Architekturen mit vCluster und Hierarchical Namespaces',
          'Kubernetes Security Hardening nach CIS Kubernetes Benchmark Richtlinien',
          'Kubernetes Event-Exporting und Incident Detection mit Falco und BotKube'
        ]
      },
      {
        title: 'Skalierung, GitOps, CI/CD & Observability',
        icon: 'trending-up',
        summary: 'Autoscaling (HPA, KEDA, VPA), GitOps Workflows mit ArgoCD, Helm v3, Kustomize und Prometheus/Grafana Monitoring.',
        articles: [
          {
            title: 'Horizontal Pod Autoscaler (HPA) & KEDA Event-Driven Autoscaling',
            icon: 'trending-up',
            summary: 'Skalierung von Kubernetes Workloads basierend auf CPU/Memory und externen Triggern (Kafka, RabbitMQ, Redis).',
            sections: [
              {
                heading: 'KEDA ScaledObject für Message Queues',
                content: 'Automatische Skalierung von 0 auf N Pods abhängig von der Queue-Länge.',
                code: {
                  language: 'yaml',
                  snippet: 'apiVersion: keda.sh/v1alpha1\nkind: ScaledObject\nmetadata:\n  name: rabbitmq-consumer-scaler\nspec:\n  scaleTargetRef:\n    name: order-processor\n  minReplicaCount: 0\n  maxReplicaCount: 30\n  triggers:\n  - type: rabbitmq\n    metadata:\n      queueName: orders\n      mode: QueueLength\n      value: "20"'
                }
              }
            ]
          },
          {
            title: 'GitOps mit ArgoCD: Deklarative Clusterverwaltung und Sync-Strategien',
            icon: 'git-branch',
            summary: 'Automatisierte Synchronisation von Git-Repositories auf Kubernetes Cluster mit Self-Healing und Rollouts.',
            sections: [
              {
                heading: 'ArgoCD Application CRD',
                content: 'Zentrales Manifest zur Definition von Quell-Repository und Ziel-Cluster.',
                code: {
                  language: 'yaml',
                  snippet: 'apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: production-app-stack\n  namespace: argocd\nspec:\n  project: default\n  source:\n    repoURL: https://github.com/company/k8s-gitops.git\n    targetRevision: main\n    path: envs/production\n  destination:\n    server: https://kubernetes.default.svc\n    namespace: prod\n  syncPolicy:\n    automated:\n      prune: true\n      selfHeal: true'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'Vertical Pod Autoscaler (VPA) und Cluster Autoscaler Best Practices',
          'Resource Requests, Limits und Kubernetes QoS Klassen (Guaranteed, Burstable)',
          'Helm v3: Chart-Entwicklung, Dependency Management und Release Hooks',
          'Kustomize: Deklarative Konfigurations-Overlays für Multi-Environment Deployments',
          'Prometheus und Grafana Monitoring im Cluster mit kube-prometheus-stack',
          'Zentralisierte Log-Aggregation mit Vector, Fluentbit und Grafana Loki'
        ]
      },
      {
        title: 'Storage & Persistenz (CSI)',
        icon: 'hard-drive',
        summary: 'Container Storage Interface (CSI), dynamisches Storage-Provisioning, StorageClasses und Volume Snapshots.',
        articles: [],
        extraTopics: [
          'Kubernetes Storage Architektur: StorageClasses, Dynamic Provisioning und CSI'
        ]
      }
    ]
  },

  // =========================================================================
  // 4. SECRETS MANAGEMENT SPACE (~38 articles organized in 6 Topic parent pages)
  // =========================================================================
  {
    key: 'SECRETS',
    name: 'Secrets Management & Enterprise Security',
    icon: 'shield-alert',
    description: 'Architektur und Workflows für HashiCorp Vault, Mozilla SOPS, Sealed Secrets, cert-manager, OIDC und Zero-Trust PKI.',
    topics: [
      {
        title: 'HashiCorp Vault & Enterprise Key Management',
        icon: 'lock',
        summary: 'HashiCorp Vault Architektur, Shamir Unseal, Dynamic PostgreSQL Secrets, PKI Engine, Vault Secrets Operator und HSMs.',
        articles: [
          {
            title: 'HashiCorp Vault Architektur: Storage Backends, Shamir Keys & Auto-Unseal',
            icon: 'lock',
            summary: 'Grundlagen des Enterprise Secrets Managements mit Vault, Envelope Encryption und Hochverfügbarkeit.',
            sections: [
              {
                heading: 'Vault Entsiegelungs-Mechanismus (Shamir Secret Sharing)',
                content: 'Vault verschlüsselt seinen Master Key in N Shares, von denen ein Schwellenwert T zur Entsiegelung erforderlich ist. Im Cloud-Betrieb wird Auto-Unseal via Cloud KMS (AWS KMS, Azure Key Vault, GCP KMS) oder Transit Engine empfohlen.'
              },
              {
                heading: 'Vault Agent Auto-Auth & Token Lifecycle',
                content: 'Automatisierte Authentifizierung von Kubernetes Pods gegen Vault ohne statische Passwörter.',
                code: {
                  language: 'hcl',
                  snippet: 'auto_auth {\n  method "kubernetes" {\n    mount_path = "auth/kubernetes"\n    config = {\n      role = "banking-api-role"\n    }\n  }\n  sink "file" {\n    config = {\n      path = "/vault/secrets/token"\n    }\n  }\n}'
                }
              }
            ]
          },
          {
            title: 'Vault Dynamic Secrets: Just-In-Time PostgreSQL Credentials',
            icon: 'database',
            summary: 'Generierung kurzlebiger Datenbank-Benutzer mit automatischer Ablaufzeit und automatischem Entzug.',
            sections: [
              {
                heading: 'Konfiguration der Database Secrets Engine',
                content: 'Anwendungen fordern bei Bedarf temporäre Zugangsdaten an, die nach Ablauf der TTL (z. B. 1 Stunde) von Vault automatisch gelöscht werden.',
                code: {
                  language: 'bash',
                  snippet: '# Rolle für dynamische PostgreSQL Benutzer anlegen\nvault write database/roles/app-readonly \\\n    db_name=postgres-prod \\\n    creation_statements="CREATE ROLE \\"{{name}}\\" WITH LOGIN PASSWORD \'{{password}}\' VALID UNTIL \'{{expiration}}\'; GRANT SELECT ON ALL TABLES IN SCHEMA public TO \\"{{name}}\\";" \\\n    default_ttl="1h" \\\n    max_ttl="24h"'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'HashiCorp Vault Auth-Methoden: Kubernetes, AppRole, OIDC und Cloud IAM',
          'HashiCorp Vault PKI Secrets Engine: Automatisiertes Zertifikats-Management',
          'Vault Secrets Operator (VSO) zur nativen Kubernetes Secrets Integration',
          'Hardware Security Modules (HSM) und Cloud KMS (AWS KMS, GCP KMS, Vault Transit)'
        ]
      },
      {
        title: 'GitOps Secrets & Kubernetes Integration',
        icon: 'key',
        summary: 'Mozilla SOPS & Age Verschlüsselung, External Secrets Operator (ESO), Sealed Secrets und K8s Secrets Encryption at Rest.',
        articles: [
          {
            title: 'Mozilla SOPS & Age: GitOps Secrets sicher im Repository versionieren',
            icon: 'key',
            summary: 'Verschlüsselung sensibler YAML-Werte in Git mit modernen Age-Schlüsseln oder Cloud KMS.',
            sections: [
              {
                heading: 'SOPS Konfiguration (.sops.yaml)',
                content: 'SOPS verschlüsselt nur die Werte von YAML/JSON-Dateien, während Schlüssel für Diffs und GitOps Operatoren lesbar bleiben.',
                code: {
                  language: 'yaml',
                  snippet: 'creation_rules:\n  - path_regex: .*/secrets/.*\\.ya?ml$\n    age: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p\n    encrypted_regex: "^(data|stringData)$"'
                }
              },
              {
                heading: 'Verschlüsseln und Entschlüsseln im Workflow',
                content: 'Einfache Befehle für die Entwickler-CLI.',
                code: {
                  language: 'bash',
                  snippet: '# Datei in-place verschlüsseln\nsops -e -i k8s/production/secrets.yaml\n\n# Verschlüsselte Datei direkt im Editor bearbeiten\nsops k8s/production/secrets.yaml'
                }
              }
            ]
          },
          {
            title: 'External Secrets Operator (ESO) in Kubernetes',
            icon: 'refresh-cw',
            summary: 'Synchronisation von Secrets aus HashiCorp Vault, AWS Secrets Manager und Azure Key Vault in native K8s Secrets.',
            sections: [
              {
                heading: 'SecretStore und ExternalSecret Ressourcen',
                content: 'ESO entkoppelt die Secrets-Quelle von den Pod-Deployments und aktualisiert Secrets bei Änderungen in Echtzeit.',
                code: {
                  language: 'yaml',
                  snippet: 'apiVersion: external-secrets.io/v1beta1\nkind: ExternalSecret\nmetadata:\n  name: database-credentials\nspec:\n  refreshInterval: "1h"\n  secretStoreRef:\n    name: vault-backend\n    kind: ClusterSecretStore\n  target:\n    name: app-db-secret\n    creationPolicy: Owner\n  data:\n  - secretKey: password\n    remoteRef:\n      key: secret/data/database\n      property: db_password'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'Bitnami Sealed Secrets: Asymmetrische Secrets-Verschlüsselung für GitOps',
          'Kubernetes Secrets Encryption at Rest mit Cloud KMS Providern',
          'Secrets Injection via Environment Variables vs RAMFS File Mounts'
        ]
      },
      {
        title: 'Identity, IAM, OIDC & Zero Trust Access',
        icon: 'user-check',
        summary: 'OpenID Connect (OIDC), Keycloak IdP Föderation, JWT Token Security, PAM, Zero Trust Netzwerke und SPIFFE/SPIRE.',
        articles: [
          {
            title: 'OpenID Connect (OIDC) & Keycloak Enterprise Identity Architecture',
            icon: 'user-check',
            summary: 'Zentralisierte Authentifizierung, OAuth 2.0 Token Exchange und Single Sign-On (SSO).',
            sections: [
              {
                heading: 'Der OIDC Authorization Code Flow mit PKCE',
                content: 'Sicherer Standard für Single Page Applications (SPAs) und Backend-Dienste ohne statische Client Secrets.'
              }
            ]
          }
        ],
        extraTopics: [
          'Keycloak Setup und Identity Provider (IdP) Föderation mit Active Directory/LDAP',
          'JSON Web Tokens (JWT) Security: RS256 vs EdDSA und Token Validation Best Practices',
          'Privileged Access Management (PAM) und Just-In-Time Credential Issuance',
          'Zero Trust Network Architecture (ZTNA) und Identity-Aware Access Proxies',
          'Workload Identity und Service-to-Service Authentifizierung mit SPIFFE/SPIRE',
          'API Key und Access Token Lifecycle: Scopes, Expiration und Revocation Lists',
          'Access Token Revocation Lists und Short-Lived Tokens Architekturen',
          'Enterprise Password Management mit Bitwarden/Vaultwarden Self-Hosting'
        ]
      },
      {
        title: 'PKI, TLS/mTLS, SSH & Hardware Tokens',
        icon: 'shield',
        summary: 'cert-manager für Kubernetes TLS, mTLS, SSH Certificate Authorities, YubiKey FIDO2/WebAuthn und WireGuard VPNs.',
        articles: [
          {
            title: 'cert-manager: Automatisierte TLS-Zertifikate mit Let\'s Encrypt & Private PKI',
            icon: 'shield',
            summary: 'Vollautomatische Ausstellung und Erneuerung von X.509 Zertifikaten im Kubernetes Cluster.',
            sections: [
              {
                heading: 'ClusterIssuer mit ACME DNS-01 Challenge',
                content: 'DNS-01 ermöglicht das Ausstellen von Wildcard-Zertifikaten ohne exponierte HTTP-Endpunkte.',
                code: {
                  language: 'yaml',
                  snippet: 'apiVersion: cert-manager.io/v1\nkind: ClusterIssuer\nmetadata:\n  name: letsencrypt-production\nspec:\n  acme:\n    server: https://acme-v02.api.letsencrypt.org/directory\n    email: security@company.com\n    privateKeySecretRef:\n      name: letsencrypt-prod-account-key\n    solvers:\n    - dns01:\n        cloudflare:\n          apiTokenSecretRef:\n            name: cloudflare-api-token-secret\n            key: api-token'
                }
              }
            ]
          }
        ],
        extraTopics: [
          'TLS und mTLS Grundlagen: Handshakes, Cipher Suites, Forward Secrecy und ALPN',
          'SSH Certificates vs SSH Keys: Enterprise Access Management auf Flotten-Ebene',
          'Automatisierte SSH Host-Key Rotation und Certificate Revocation Lists (CRL)',
          'YubiKey und Hardware-Token Integration mit FIDO2, WebAuthn und PIV Smartcards',
          'Hardware Security Keys Backup- und Recovery-Strategien für Administratoren',
          'WireGuard VPN Security: Asymmetrische Schlüsselpaare und Pre-Shared Keys'
        ]
      },
      {
        title: 'Kryptografie, Secrets Lifecycle & Incident Response',
        icon: 'shield-alert',
        summary: 'Secrets Rotation, Zero-Downtime Datenbank-Passwörter, LUKS Verschlüsselung, Secret Scanning und Incident Response.',
        articles: [],
        extraTopics: [
          'Secrets Rotation Strategien: Automatisierter Zero-Downtime Key Rollover',
          'Datenbank-Passwort-Rotation im laufenden Betrieb ohne Applikations-Neustart',
          'Data Protection at Rest: LUKS Volume Encryption und Encrypted Database Storage',
          'Envelope Encryption und Key Derivation Functions (Argon2, PBKDF2, scrypt)',
          'Cryptographic Agility und Post-Quantum Cryptography (PQC) Migration',
          'Secret Scanning in CI/CD mit Gitleaks, TruffleHog und Pre-Commit Hooks',
          'Secrets Leak Incident Response: Triage, Revocation und Forensik-Workflow',
          'Supply Chain Security: Sigstore Cosign und Software Bill of Materials (SBOM)'
        ]
      },
      {
        title: 'Compliance, Governance & Best Practices',
        icon: 'file-check',
        summary: 'Audit Trails, BSI IT-Grundschutz / ISO 27001 / SOC 2 Secrets Controls, Anti-Patterns und Security Blueprints.',
        articles: [],
        extraTopics: [
          'Audit Trails und Compliance-konformes Logging für kryptografische Operationen',
          'Compliance & Audit Readiness: BSI IT-Grundschutz, ISO 27001 und SOC 2 Secrets Controls',
          'Secrets Management Anti-Patterns: Die 10 häufigsten Sicherheitslücken in der Praxis',
          'Enterprise Secrets Management Blueprint und Best Practices Checkliste'
        ]
      }
    ]
  }
];

function generateArticleHtml(article: ArticleData): { html: string; text: string } {
  let html = `<h1>${article.title}</h1>`;
  html += `<p class="lead"><strong>Überblick:</strong> ${article.summary}</p>`;
  let text = `${article.title}\n\nÜberblick: ${article.summary}\n\n`;

  for (const sec of article.sections) {
    html += `<h2>${sec.heading}</h2>`;
    html += `<p>${sec.content}</p>`;
    text += `${sec.heading}\n${sec.content}\n\n`;

    if (sec.table) {
      html += `<table class="table-auto border-collapse w-full my-4 border border-border"><thead><tr class="bg-muted">`;
      for (const h of sec.table.headers) {
        html += `<th class="border border-border px-4 py-2 text-left font-semibold">${h}</th>`;
      }
      html += `</tr></thead><tbody>`;
      for (const row of sec.table.rows) {
        html += `<tr>`;
        for (const cell of row) {
          html += `<td class="border border-border px-4 py-2">${cell}</td>`;
        }
        html += `</tr>`;
      }
      html += `</tbody></table>`;
    }

    if (sec.code) {
      html += `<pre><code class="language-${sec.code.language}">${sec.code.snippet.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
      text += `Code (${sec.code.language}):\n${sec.code.snippet}\n\n`;
    }

    if (sec.tip) {
      html += `<div class="p-4 my-4 rounded-md border-l-4 border-primary bg-muted"><p class="font-medium text-sm">💡 Praxistipp: ${sec.tip}</p></div>`;
      text += `Praxistipp: ${sec.tip}\n\n`;
    }
  }

  html += `<h2>Zusammenfassung & Best Practices</h2>`;
  html += `<ul>`;
  html += `<li>Konfigurationen stets versionskontrolliert und automatisiert ausrollen.</li>`;
  html += `<li>Zugriffsrechte nach dem Principle of Least Privilege (PoLP) strikt einschränken.</li>`;
  html += `<li>Monitoring, Healthchecks und Audit-Logs kontinuierlich überwachen und alarmieren.</li>`;
  html += `</ul>`;

  text += `Zusammenfassung & Best Practices:\n- Konfigurationen stets versionskontrolliert und automatisiert ausrollen.\n- Zugriffsrechte nach dem Principle of Least Privilege (PoLP) strikt einschränken.\n- Monitoring, Healthchecks und Audit-Logs kontinuierlich überwachen und alarmieren.\n`;

  return { html, text };
}

function generateTopicOverviewHtml(topic: TopicData, subArticles: ArticleData[]): { html: string; text: string } {
  let html = `<h1>${topic.title}</h1>`;
  html += `<p class="lead"><strong>Themenbereich:</strong> ${topic.summary}</p>`;
  let text = `${topic.title}\n\nThemenbereich: ${topic.summary}\n\n`;

  html += `<h2>1. Übersicht & Zielsetzung</h2>`;
  html += `<p>Dieser Themenbereich bündelt praxisorientierte Architekturleitfäden, Konfigurationsstandards und Best Practices für ${topic.title}. Die nachfolgenden Unterseiten bieten detaillierte technische Anleitungen für Administratoren und DevOps Engineers.</p>`;
  text += `1. Übersicht & Zielsetzung\nDieser Themenbereich bündelt praxisorientierte Architekturleitfäden, Konfigurationsstandards und Best Practices für ${topic.title}.\n\n`;

  html += `<h2>2. Enthaltene Fachartikel in dieser Kategorie</h2>`;
  html += `<p>Folgende Dokumentationen und Anleitungen sind in diesem Bereich strukturiert verfügbar:</p>`;
  html += `<table class="table-auto border-collapse w-full my-4 border border-border"><thead><tr class="bg-muted">`;
  html += `<th class="border border-border px-4 py-2 text-left font-semibold">Dokumentationstitel</th>`;
  html += `<th class="border border-border px-4 py-2 text-left font-semibold">Themenschwerpunkt & Inhalt</th>`;
  html += `</tr></thead><tbody>`;

  for (const article of subArticles) {
    html += `<tr>`;
    html += `<td class="border border-border px-4 py-2 font-medium">📄 ${article.title}</td>`;
    html += `<td class="border border-border px-4 py-2 text-muted-foreground">${article.summary}</td>`;
    html += `</tr>`;
    text += `- ${article.title}: ${article.summary}\n`;
  }
  html += `</tbody></table>`;
  text += `\n`;

  html += `<h2>3. Architektur- & Betriebsempfehlungen</h2>`;
  html += `<ul>`;
  html += `<li><strong>Strukturierte Dokumentation:</strong> Alle Systemänderungen und Konfigurationsparameter sind lückenlos dokumentiert.</li>`;
  html += `<li><strong>Automatisierung:</strong> Wiederkehrende Wartungsaufgaben und Deployments erfolgen über deklarative CI/CD Pipelines und GitOps.</li>`;
  html += `<li><strong>Sicherheit & Compliance:</strong> Implementierung des Least-Privilege-Prinzips und kontinuierliches Security Auditing.</li>`;
  html += `</ul>`;

  text += `3. Architektur- & Betriebsempfehlungen\n- Strukturierte Dokumentation aller Systemänderungen\n- Automatisierung über CI/CD und GitOps\n- Sicherheit & Compliance nach Least-Privilege\n`;

  return { html, text };
}

async function run() {
  const client = await pool.connect();
  try {
    console.log('Connecting to database...');
    
    // Get user id for simon / admin
    const userRes = await client.query(`SELECT id FROM users WHERE username = 'simon' UNION SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
    const userId = userRes.rows[0]?.id || '00000000-0000-0000-0000-000000000000';
    console.log(`Using Author User ID: ${userId}`);

    let totalTopicsCreated = 0;
    let totalArticlesCreated = 0;

    // Clean up previous generated pages for these spaces
    await client.query(`DELETE FROM pages WHERE space_key IN ('LINUX', 'DOCKER', 'K8S', 'SECRETS')`);

    for (const space of spaces) {
      console.log(`\n========================================`);
      console.log(`Processing Space: ${space.name} (${space.key})`);
      console.log(`========================================`);

      // 1. Create or ensure Space exists
      await client.query(
        `INSERT INTO spaces (space_key, space_name, description, source, icon, created_by)
         VALUES ($1, $2, $3, 'local', $4, $5)
         ON CONFLICT (space_key) DO UPDATE
         SET space_name = EXCLUDED.space_name, description = EXCLUDED.description`,
        [space.key, space.name, space.description, space.icon, userId]
      );

      let topicSortOrder = 0;

      for (const topic of space.topics) {
        topicSortOrder++;

        // Collect all articles for this topic (handcrafted + extra programmatic topics)
        const subArticles: ArticleData[] = [...topic.articles];
        if (topic.extraTopics) {
          for (const extraTitle of topic.extraTopics) {
            subArticles.push({
              title: extraTitle,
              icon: topic.icon,
              summary: `Tiefgehende technische Dokumentation, Architekturmuster und Best Practices zum Thema ${extraTitle}.`,
              sections: [
                {
                  heading: '1. Architektur & Grundlagen',
                  content: `Das Konzept von "${extraTitle}" bildet einen integralen Bestandteil moderner Enterprise-Infrastrukturen. In diesem Dokument werden Funktionsweisen, Konfigurationsstandards und Sicherheitsrichtlinien im Detail erläutert.`
                },
                {
                  heading: '2. Implementierung & Konfiguration',
                  content: `Folgende Konfiguration demonstriert den produktionsreifen Einsatz von ${extraTitle} unter Einhaltung von Sicherheits- und Hochverfügbarkeits-Vorgaben:`,
                  code: {
                    language: 'bash',
                    snippet: `# Status und Validierung von ${extraTitle}\nsystemctl status || kubectl get pods -A || docker ps\n\n# Konfigurationsprüfung und Syntax-Check\necho "Prüfung für ${extraTitle} erfolgreich abgeschlossen"`
                  },
                  tip: `Regelmäßige automatisierte Tests und Continuous Verification stellen sicher, dass Konfigurationen konsistent bleiben.`
                },
                {
                  heading: '3. Troubleshooting & Betrieb',
                  content: `Typische Fehlerbilder bei ${extraTitle} umfassen Berechtigungsverweigerungen, Ressourcenengpässe oder Timeout-Probleme. Audit-Logs und Metriken liefern hierzu die primären Anhaltspunkte zur Ursachenanalyse.`
                }
              ]
            });
          }
        }

        // 2. Create Topic Parent Page (depth 0, parent_id null)
        const { html: topicHtml, text: topicText } = generateTopicOverviewHtml(topic, subArticles);

        const topicRes = await client.query<{ id: number }>(
          `INSERT INTO pages (
            space_key, title, body_html, body_text, version, source, visibility,
            page_type, created_by_user_id, owner_id, depth, sort_order, parent_id,
            embedding_dirty, embedding_status, quality_status, summary_status,
            icon_kind, icon_value
           )
           VALUES (
            $1, $2, $3, $4, 1, 'standalone', 'shared',
            'page', $5, $5, 0, $6, NULL,
            true, 'not_embedded', 'pending', 'pending',
            'lucide', $7
           )
           RETURNING id`,
          [space.key, topic.title, topicHtml, topicText, userId, topicSortOrder, topic.icon]
        );

        const topicPageId = topicRes.rows[0]?.id;
        if (!topicPageId) continue;
        // Update materialized path for topic parent page (/id)
        await client.query(`UPDATE pages SET path = $1 WHERE id = $2`, [`/${topicPageId}`, topicPageId]);

        await client.query(
          `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text, author, message)
           VALUES ($1, 1, $2, $3, $4, 'System Seed', 'Initial creation of topic overview page')`,
          [topicPageId, topic.title, topicHtml, topicText]
        );

        totalTopicsCreated++;
        console.log(`Created Topic Parent: "${topic.title}" (ID: ${topicPageId}) with ${subArticles.length} sub-pages`);

        // 3. Create Sub-Pages under Topic Parent (depth 1, parent_id = topicPageId)
        let subSortOrder = 0;
        for (const article of subArticles) {
          subSortOrder++;
          const { html: articleHtml, text: articleText } = generateArticleHtml(article);

          const subRes = await client.query<{ id: number }>(
            `INSERT INTO pages (
              space_key, title, body_html, body_text, version, source, visibility,
              page_type, created_by_user_id, owner_id, depth, sort_order, parent_id,
              embedding_dirty, embedding_status, quality_status, summary_status,
              icon_kind, icon_value
             )
             VALUES (
              $1, $2, $3, $4, 1, 'standalone', 'shared',
              'page', $5, $5, 1, $6, $7,
              true, 'not_embedded', 'pending', 'pending',
              'lucide', $8
             )
             RETURNING id`,
            [space.key, article.title, articleHtml, articleText, userId, subSortOrder, String(topicPageId), article.icon]
          );

          const subPageId = subRes.rows[0]?.id;
          if (!subPageId) continue;
          // Update materialized path for sub-page (/parent_id/id)
          await client.query(`UPDATE pages SET path = $1 WHERE id = $2`, [`/${topicPageId}/${subPageId}`, subPageId]);

          await client.query(
            `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text, author, message)
             VALUES ($1, 1, $2, $3, $4, 'System Seed', 'Initial creation of technical article')`,
            [subPageId, article.title, articleHtml, articleText]
          );

          totalArticlesCreated++;
        }
      }
    }

    console.log(`\n========================================`);
    console.log(`Successfully generated:`);
    console.log(`- ${totalTopicsCreated} Topic parent pages (depth 0)`);
    console.log(`- ${totalArticlesCreated} Technical sub-pages (depth 1)`);
    console.log(`Total pages: ${totalTopicsCreated + totalArticlesCreated} across 4 spaces!`);
    console.log(`========================================\n`);

  } catch (err) {
    console.error('Error generating technical articles:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
