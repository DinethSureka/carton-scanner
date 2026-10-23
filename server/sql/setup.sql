/* =====================================================================
   Carton Scanner - database setup (run once in SSMS)
   Server : localhost\SQLEXPRESS
   Creates: database ContainerTracking, tables dbo.ContainerCartonScan and dbo.AppUsers
   Safe to re-run: nothing is dropped.
   ===================================================================== */

IF DB_ID(N'ContainerTracking') IS NULL
    CREATE DATABASE ContainerTracking;
GO

USE ContainerTracking;
GO

IF OBJECT_ID(N'dbo.ContainerCartonScan', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.ContainerCartonScan
    (
        Id              BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
        ContainerNumber NVARCHAR(20)  NOT NULL,
        CartonId        NVARCHAR(50)  NOT NULL,
        ScanDateTime    DATETIME2(0)  NOT NULL CONSTRAINT DF_ContainerCartonScan_ScanDateTime DEFAULT (SYSDATETIME()),
        UserName        NVARCHAR(50)  NULL,
        CONSTRAINT UQ_ContainerCartonScan UNIQUE (ContainerNumber, CartonId)
    );

    CREATE INDEX IX_ContainerCartonScan_Container ON dbo.ContainerCartonScan (ContainerNumber);
    CREATE INDEX IX_ContainerCartonScan_DateTime  ON dbo.ContainerCartonScan (ScanDateTime);
END
GO

-- Users and roles for the login (the server also creates this automatically on first start)
IF OBJECT_ID(N'dbo.AppUsers', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AppUsers
    (
        UserId             INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AppUsers PRIMARY KEY,
        UserName           NVARCHAR(50)  NOT NULL CONSTRAINT UQ_AppUsers_UserName UNIQUE,
        FullName           NVARCHAR(100) NULL,
        Role               NVARCHAR(20)  NOT NULL CONSTRAINT CK_AppUsers_Role CHECK (Role IN (N'Admin', N'Supervisor', N'User')),
        PasswordHash       NVARCHAR(200) NOT NULL,
        MustChangePassword BIT           NOT NULL CONSTRAINT DF_AppUsers_MustChange DEFAULT (1),
        IsActive           BIT           NOT NULL CONSTRAINT DF_AppUsers_IsActive DEFAULT (1),
        TokenVersion       INT           NOT NULL CONSTRAINT DF_AppUsers_TokenVersion DEFAULT (1),
        CreatedAt          DATETIME2(0)  NOT NULL CONSTRAINT DF_AppUsers_CreatedAt DEFAULT (SYSDATETIME()),
        LastLoginAt        DATETIME2(0)  NULL
    );
END
GO

/* Useful queries
   SELECT * FROM dbo.ContainerCartonScan ORDER BY ScanDateTime DESC;

   SELECT ContainerNumber, COUNT(*) AS Cartons,
          MIN(ScanDateTime) AS FirstScan, MAX(ScanDateTime) AS LastScan
   FROM dbo.ContainerCartonScan
   GROUP BY ContainerNumber
   ORDER BY LastScan DESC;
*/
