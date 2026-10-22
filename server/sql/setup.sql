/* =====================================================================
   Carton Scanner - database setup (run once in SSMS)
   Server : localhost\SQLEXPRESS
   Creates: database ContainerTracking, table dbo.ContainerCartonScan
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

/* Useful queries
   SELECT * FROM dbo.ContainerCartonScan ORDER BY ScanDateTime DESC;

   SELECT ContainerNumber, COUNT(*) AS Cartons,
          MIN(ScanDateTime) AS FirstScan, MAX(ScanDateTime) AS LastScan
   FROM dbo.ContainerCartonScan
   GROUP BY ContainerNumber
   ORDER BY LastScan DESC;
*/
