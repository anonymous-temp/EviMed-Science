package com.sentum.infrastructure.config;


import java.sql.*;

public class Sql {

    // 数据库连接信息
    private static final String URL = "jdbc:mysql://127.0.0.1:3306/faer_a";
    private static final String USER = "root";
    private static final String PASSWORD = "199810";

    public static void main(String[] args) throws SQLException, ClassNotFoundException {
        deletePlayer();
    }


    private static void createDelete() throws SQLException {
        for (int i = 0; i < 4; i++) {
            for (int j = 0; j < 4; j++) {
                int ix = 2021 + i;
                int jx = 1 + j;
                if (j == 5 && j > 1) {
                    break;
                }
                String tab = ix + "q" + jx;
                String sql = "CREATE TABLE `delete_" + tab + "` (\n" +
                        "  `caseId` varchar(255) NOT NULL,\n" +
                        "  PRIMARY KEY (`caseId`)\n" +
                        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;";

                ex(sql);


            }
        }


    }

    private static void deletePlayer() throws SQLException {
//        for (int i = 0; i < 7; i++) {
//            for (int j = 0; j < 4; j++) {
//                int ix = 15 + i;
//                int jx = 1 + j;
//                String tab = ix + "q" + jx;
                String sql = "DELETE aligned_demo_drug_reac_indi_ther_psx"+ "\n" +
                        "FROM aligned_demo_drug_reac_indi_ther_psx"  + "\n" +
                        "INNER JOIN delete_all ON aligned_demo_drug_reac_indi_ther_psx" + ".caseid = delete_all.caseId;";
                ex(sql);
                for (int x = 0; x < 6; x++) {
                    for (int y = 0; y < 4; y++) {
                        int xx = 2019 + x;
                        int yy = 1 + y;
                        if (x == 5 && y > 1) {
                            break;
                        }
                        String table = xx + "q" + yy;
//                        if (xx < (2015 + i)) {
//                            System.out.println("跳过" + tab + "||||" + table);
//                            continue;
//                        }

                        String table1 = "delete_" + table;
                        String table2 = "aligned_demo_drug_reac_indi_ther_psx";


                        String sql1 = "DELETE FROM " + table2 + " \n" +
                                "WHERE CASEID IN (SELECT CASEID FROM " + table1 + ");\n";
                        ex(sql1);
                        System.out.println("执行成功" + "x" + "||||" + table);


                    }
                }


//            }
//        }


    }


    private static void endHebing() throws SQLException {
        for (int i = 0; i < 7; i++) {
            for (int j = 0; j < 4; j++) {
                int ix = 15 + i;
                int jx = 1 + j;
                String tab = ix + "q" + jx;
                String alias = "aligned_demo_drug_reac_indi_ther_ps" + tab;
                String sql = "INSERT INTO aligned_demo_drug_reac_indi_ther_ps\n" +
                        "SELECT * FROM " + alias + " \n" +
                        "UNION ALL;";
                ex(sql);

            }
        }
    }


    private static void addIndex() {
        for (int i = 0; i < 7; i++) {
            for (int j = 0; j < 4; j++) {
                int ix = 15 + i;
                int jx = 1 + j;
                String tab = ix + "q" + jx;
                String alias = "aligned_demo_drug_reac_indi_ther_ps" + tab;
                String sql = "CREATE INDEX idx_caseid ON " + alias + "(CASEID);";
                try (Connection connection = DriverManager.getConnection(URL, USER, PASSWORD)) {
                    Statement stmt = connection.createStatement();
                    stmt.execute(sql);
                } catch (SQLException e) {

                }

            }
        }
    }

    //去重
    private static void deleteRepeat() throws SQLException {
        for (int i = 0; i < 7; i++) {
            for (int j = 0; j < 4; j++) {
                int ix = 15 + i;
                int jx = 1 + j;
                String tab = ix + "q" + jx;
                String alias = "aligned_demo_drug_reac_indi_ther_ps";


//                String sql1 = "DELETE t1\n" +
//                        "FROM "+ alias+" t1\n" +
//                        "JOIN (\n" +
//                        "    SELECT *,\n" +
//                        "           row_number() OVER (\n" +
//                        "               PARTITION BY event_dt, AGE,AGE_COD, sex, reporter_country, Aligned_drugs, Aligned_INDI, Aligned_START_DATE, ALIGNED_REAC\n" +
//                        "               ORDER BY primaryid DESC\n" +
//                        "           ) AS row_num\n" +
//                        "    FROM "+alias+"\n" +
//                        ") t2\n" +
//                        "ON t1.primaryid = t2.primaryid \n" +
//                        "WHERE t2.row_num > 1;";
//                String sql2 = "DELETE t1\n" +
//                        "FROM "+ alias+" t1\n" +
//                        "JOIN (\n" +
//                        "    SELECT *,\n" +
//                        "           row_number() OVER (\n" +
//                        "               PARTITION BY  AGE,AGE_COD, sex, reporter_country, Aligned_drugs, Aligned_INDI, Aligned_START_DATE, ALIGNED_REAC\n" +
//                        "               ORDER BY primaryid DESC\n" +
//                        "           ) AS row_num\n" +
//                        "    FROM "+alias+"\n" +
//                        ") t2\n" +
//                        "ON t1.primaryid = t2.primaryid \n" +
//                        "WHERE t2.row_num > 1;";
//
//                String sql3 = "DELETE t1\n" +
//                        "FROM "+ alias+" t1\n" +
//                        "JOIN (\n" +
//                        "    SELECT *,\n" +
//                        "           row_number() OVER (\n" +
//                        "               PARTITION BY event_dt, sex, reporter_country, Aligned_drugs, Aligned_INDI, Aligned_START_DATE, ALIGNED_REAC\n" +
//                        "               ORDER BY primaryid DESC\n" +
//                        "           ) AS row_num\n" +
//                        "    FROM "+alias+"\n" +
//                        ") t2\n" +
//                        "ON t1.primaryid = t2.primaryid \n" +
//                        "WHERE t2.row_num > 1;";
//
//                String sql4 = "DELETE t1\n" +
//                        "FROM "+ alias+" t1\n" +
//                        "JOIN (\n" +
//                        "    SELECT *,\n" +
//                        "           row_number() OVER (\n" +
//                        "               PARTITION BY event_dt, AGE,AGE_COD, reporter_country, Aligned_drugs, Aligned_INDI, Aligned_START_DATE, ALIGNED_REAC\n" +
//                        "               ORDER BY primaryid DESC\n" +
//                        "           ) AS row_num\n" +
//                        "    FROM "+alias+"\n" +
//                        ") t2\n" +
//                        "ON t1.primaryid = t2.primaryid \n" +
//                        "WHERE t2.row_num > 1;";
//
//                String sql5 = "DELETE t1\n" +
//                        "FROM "+ alias+" t1\n" +
//                        "JOIN (\n" +
//                        "    SELECT *,\n" +
//                        "           row_number() OVER (\n" +
//                        "               PARTITION BY event_dt, AGE,AGE_COD, sex, Aligned_drugs, Aligned_INDI, Aligned_START_DATE, ALIGNED_REAC\n" +
//                        "               ORDER BY primaryid DESC\n" +
//                        "           ) AS row_num\n" +
//                        "    FROM "+alias+"\n" +
//                        ") t2\n" +
//                        "ON t1.primaryid = t2.primaryid \n" +
//                        "WHERE t2.row_num > 1;";
//
//                String sql6 = "DELETE t1\n" +
//                        "FROM "+ alias+" t1\n" +
//                        "JOIN (\n" +
//                        "    SELECT *,\n" +
//                        "           row_number() OVER (\n" +
//                        "               PARTITION BY event_dt, AGE,AGE_COD, sex, reporter_country, Aligned_drugs, Aligned_START_DATE, ALIGNED_REAC\n" +
//                        "               ORDER BY primaryid DESC\n" +
//                        "           ) AS row_num\n" +
//                        "    FROM "+alias+"\n" +
//                        ") t2\n" +
//                        "ON t1.primaryid = t2.primaryid \n" +
//                        "WHERE t2.row_num > 1;";
//
//
//                String sql7 = "DELETE t1\n" +
//                        "FROM "+ alias+" t1\n" +
//                        "JOIN (\n" +
//                        "    SELECT *,\n" +
//                        "           row_number() OVER (\n" +
//                        "               PARTITION BY event_dt, AGE,AGE_COD, sex, reporter_country, Aligned_drugs, Aligned_INDI, ALIGNED_REAC\n" +
//                        "               ORDER BY primaryid DESC\n" +
//                        "           ) AS row_num\n" +
//                        "    FROM "+alias+"\n" +
//                        ") t2\n" +
//                        "ON t1.primaryid = t2.primaryid \n" +
//                        "WHERE t2.row_num > 1;";


                String sql7 = "DELETE t1\n" +
                        "FROM " + alias + " t1\n" +
                        "JOIN (\n" +
                        "    SELECT caseid, primaryid,\n" +
                        "           row_number() OVER (\n" +
                        "               PARTITION BY caseid\n" +
                        "               ORDER BY primaryid DESC\n" +
                        "           ) AS row_num\n" +
                        "    FROM " + alias + "\n" +
                        ") t2\n" +
                        "ON t1.caseid = t2.caseid AND t1.primaryid = t2.primaryid\n" +
                        "WHERE t2.row_num > 1;";

//                ex(sql1);
//                ex(sql2);
//                ex(sql3);
//                ex(sql4);
//                ex(sql5);
//                ex(sql6);
                ex(sql7);
                break;

            }
        }


    }


    private static void hebing() throws SQLException, ClassNotFoundException {
        for (int i = 0; i < 7; i++) {
            for (int j = 0; j < 4; j++) {
                int ix = 15 + i;
                int jx = 1 + j;
                String tab = ix + "q" + jx;


                String sql1 = "CREATE TABLE IF NOT EXISTS `aligned_demo_drug_reac_indi_ther_psx" + tab + "` (\n" +
                        "  `caseid` BIGINT DEFAULT NULL,\n" +
                        "  `primaryid` BIGINT DEFAULT NULL,\n" +
                        "  `caseversion` int DEFAULT NULL,\n" +
                        "  `fda_dt` date DEFAULT NULL,\n" +
                        "  `I_F_COD` varchar(255) DEFAULT NULL,\n" +
                        "  `event_dt` varchar(255) DEFAULT NULL,\n" +
                        "  `AGE` varchar(10) DEFAULT NULL,\n" +
                        "  `sex` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,\n" +
                        "  `reporter_country` varchar(255) DEFAULT NULL,\n" +
                        "  `OCCP_COD` varchar(255) DEFAULT NULL,\n" +
                        "  `PERIOD` varchar(255) DEFAULT NULL,\n" +
                        "  `Aligned_drugs` varchar(9999) DEFAULT NULL,\n" +
                        "  `Aligned_INDI` varchar(255) DEFAULT NULL,\n" +
                        "  `Aligned_START_DATE` varchar(255) DEFAULT NULL,\n" +
                        "  `ALIGNED_REAC` varchar(999) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,\n" +
                        "  `AGE_COD` varchar(255) DEFAULT NULL\n" +
                        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;";
// 删除已存在的表
                String dropSql = "DROP TABLE IF EXISTS `aligned_demo_drug_reac_indi_ther_psx" + tab + "`";
                ex(dropSql);

                ex(sql1);
                System.out.println("执行成功" + tab);


            }
        }


        for (int i = 0; i < 7; i++) {
            for (int j = 0; j < 4; j++) {
                int ix = 15 + i;
                int jx = 1 + j;
                String tab = ix + "q" + jx;
                String sql = "INSERT INTO Aligned_DEMO_DRUG_REAC_INDI_THER_PSx" + tab + "(\n" +
                        "    caseid, primaryid, caseversion, fda_dt, I_F_COD, event_dt, AGE, AGE_COD, sex, reporter_country, OCCP_COD, PERIOD, Aligned_drugs, Aligned_INDI, Aligned_START_DATE, ALIGNED_REAC\n" +
                        ")\n" +
                        "SELECT\n" +
                        "    caseid, primaryid, caseversion, fda_dt, I_F_COD, event_dt, AGE, AGE_COD, sex, reporter_country, OCCP_COD, '" + tab + "' AS PERIOD, Aligned_drugs,   LEFT(Aligned_INDI, 255), LEFT(Aligned_START_DATE, 255), LEFT(ALIGNED_REAC, 255)\n" +
                        "FROM (\n" +
                        "    WITH CTE AS (\n" +
                        "        SELECT\n" +
                        "            x.caseid, x.primaryid, x.caseversion, x.fda_dt, x.I_F_COD, x.event_dt,\n" +
                        "            x.AGE, x.AGE_COD, x.sex, x.reporter_country, x.OCCP_COD,\n" +
                        "            a.Aligned_drugs, b.Aligned_INDI, c.Aligned_START_DATE, d.ALIGNED_REAC\n" +
                        "        FROM\n" +
                        "            demo" + tab + " x\n" +
                        "            LEFT OUTER JOIN (\n" +
                        "                SELECT\n" +
                        "                    primaryid,\n" +
                        "                    GROUP_CONCAT(drugname SEPARATOR '/') AS Aligned_drugs\n" +
                        "                FROM\n" +
                        "                    drug" + tab + "\n" +
                        "                WHERE\n" +
                        "                    ROLE_COD = 'PS'\n" +
                        "                GROUP BY\n" +
                        "                    primaryid\n" +
                        "            ) a ON x.primaryid = a.primaryid\n" +
                        "            LEFT OUTER JOIN (\n" +
                        "                SELECT\n" +
                        "                    primaryid,\n" +
                        "                    GROUP_CONCAT(INDI_PT SEPARATOR '/') AS Aligned_INDI\n" +
                        "                FROM\n" +
                        "                    indi" + tab + "\n" +
                        "                WHERE\n" +
                        "                    INDI_PT NOT IN ('Product used for unknown indication')\n" +
                        "                GROUP BY\n" +
                        "                    primaryid\n" +
                        "            ) b ON x.primaryid = b.primaryid\n" +
                        "            LEFT OUTER JOIN (\n" +
                        "                SELECT\n" +
                        "                    primaryid,\n" +
                        "                    GROUP_CONCAT(START_DT SEPARATOR '/') AS Aligned_START_DATE\n" +
                        "                FROM\n" +
                        "                    ther" + tab + "\n" +
                        "                GROUP BY\n" +
                        "                    primaryid\n" +
                        "            ) c ON x.primaryid = c.primaryid\n" +
                        "            LEFT OUTER JOIN (\n" +
                        "                SELECT\n" +
                        "                    primaryid,\n" +
                        "                    GROUP_CONCAT(pt SEPARATOR '/') AS ALIGNED_REAC\n" +
                        "                FROM\n" +
                        "                    reac" + tab + "\n" +
                        "                GROUP BY\n" +
                        "                    primaryid\n" +
                        "            ) d ON x.primaryid = d.primaryid\n" +
                        "    )\n" +
                        "    SELECT *,\n" +
                        "           ROW_NUMBER() OVER (PARTITION BY caseid ORDER BY primaryid DESC, caseversion DESC, fda_dt DESC, I_F_COD DESC, event_dt DESC) AS row_num\n" +
                        "    FROM CTE\n" +
                        ") a\n" +
                        "WHERE a.row_num = 1; ";
                ex(sql);
                System.out.println("合并成功" + tab);


            }
        }
    }

    private static void ex(String sql) throws SQLException {


        try (Connection connection = DriverManager.getConnection(URL, USER, PASSWORD)) {
            Statement stmt = connection.createStatement();

            stmt.executeUpdate("SET SESSION group_concat_max_len = 1000000");
            executeUpdate(connection, sql);
            System.out.println("执行成功" + sql);
        }

    }


    private static void executeQuery(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet resultSet = statement.executeQuery(sql)) {

            // 处理查询结果
            while (resultSet.next()) {
                int id = resultSet.getInt("id");
                String name = resultSet.getString("name");
                System.out.println("ID: " + id + ", Name: " + name);
            }
        }
    }

    private static void executeUpdate(Connection connection, String sql) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            int rowsAffected = statement.executeUpdate();
            System.out.println("Rows affected: " + rowsAffected);
        }
    }
}
