package com.sentum.util;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.ss.util.CellRangeAddress;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.stereotype.Controller;

import javax.servlet.ServletException;
import javax.servlet.annotation.WebServlet;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;


@Controller
@WebServlet("/drugEvaluationExcel")
// 顶层数据模型类
class DrugEvaluation {
    private String _id;
    private String listId;
    private List<ListInfo> listInfo;


    public String get_id() { return _id; }
    public void set_id(String _id) { this._id = _id; }
    public String getListId() { return listId; }
    public void setListId(String listId) { this.listId = listId; }
    public List<ListInfo> getListInfo() { return listInfo; }
    public void setListInfo(List<ListInfo> listInfo) { this.listInfo = listInfo; }
}

// 药品信息类
class ListInfo {
    private String drugNames;
    private String manufacturers;
    private String title;
    private List<ScoreItem> contentlist;
    private double totalScore;
    private String _class;

    // 从厂家信息中提取规格（优化空指针处理）
    public String getSpecification() {
        if (manufacturers != null && manufacturers.contains("-")) {
            String[] parts = manufacturers.split("-", 2);
            return parts[0].trim();
        }
        return "";
    }

    public String getDrugNames() { return drugNames; }
    public void setDrugNames(String drugNames) { this.drugNames = drugNames; }
    public String getManufacturers() { return manufacturers; }
    public void setManufacturers(String manufacturers) { this.manufacturers = manufacturers; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public List<ScoreItem> getContentlist() { return contentlist; }
    public void setContentlist(List<ScoreItem> contentlist) { this.contentlist = contentlist; }
    public double getTotalScore() { return totalScore; }
    public void setTotalScore(double totalScore) { this.totalScore = totalScore; }
    public String get_class() { return _class; }
    public void set_class(String _class) { this._class = _class; }
}

// 评分项数据模型类
class ScoreItem {
    private int maxScore;
    private String title;
    private double score;
    private List<ScoreItem> children;

    public ScoreItem() {}
    public int getMaxScore() { return maxScore; }
    public void setMaxScore(int maxScore) { this.maxScore = maxScore; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public double getScore() { return score; }
    public void setScore(double score) { this.score = score; }
    public List<ScoreItem> getChildren() { return children; }
    public void setChildren(List<ScoreItem> children) { this.children = children; }
}

@WebServlet("/drugEvaluationExcel")
public class DrugEvaluationExcelServlet extends HttpServlet {
    private static int currentCol = 0; // 跟踪当前列索引
    private static final int BASIC_INFO_COL_COUNT = 7; // 基本信息列数：序号、日期、通用名、规格、厂家、单价、总分

    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {
        processRequest(request, response);
    }

    @Override
    protected void doPost(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {
        processRequest(request, response);
    }

    private void processRequest(HttpServletRequest request, HttpServletResponse response)
            throws IOException {
        try {
            // 1. 获取JSON数据 - 实际应用中可从请求参数或请求体获取
            String jsonString = getJsonData();

            // 2. 解析JSON
            ObjectMapper objectMapper = new ObjectMapper();
            DrugEvaluation evaluation = objectMapper.readValue(
                    jsonString, new TypeReference<DrugEvaluation>() {}
            );

            if (evaluation == null || evaluation.getListInfo() == null || evaluation.getListInfo().isEmpty()) {
                response.sendError(HttpServletResponse.SC_BAD_REQUEST, "没有找到有效的评估数据");
                return;
            }

            // 3. 创建Excel
            Workbook workbook = new XSSFWorkbook();
            Sheet sheet = workbook.createSheet("药品评估数据");

            // 创建表头样式
            CellStyle headerStyle = createHeaderStyle(workbook);
            int currentRow = addBasicInfoHeaders(sheet, headerStyle); // 创建表头行
            setRowHeights(sheet); // 设置行高

            CellStyle dataStyle = createDataStyle(workbook);

            // 4. 处理所有药品数据
            List<ListInfo> allDrugs = evaluation.getListInfo();
            for (ListInfo drugInfo : allDrugs) {
                // 生成多级评分表头（只需要生成一次）
                if (currentRow == 3) {
                    // 只有当有评分项时才生成评分表头
                    if (drugInfo.getContentlist() != null && !drugInfo.getContentlist().isEmpty()) {
                        generateScoreHeaders(sheet, drugInfo.getContentlist(), headerStyle, currentRow);
                    }
                }

                // 填充数据
                fillDataRow(sheet, drugInfo, currentRow, dataStyle);
                currentRow++;
            }

            // 5. 调整列宽
            adjustColumnWidths(sheet);

            // 6. 设置HTTP响应头，准备下载
            String fileName = allDrugs.get(0).getDrugNames() + "_评估数据_" +
                    new SimpleDateFormat("yyyyMMdd").format(new Date()) + ".xlsx";

            // 处理中文文件名
            String encodedFileName = new String(fileName.getBytes("UTF-8"), "ISO-8859-1");

            // 设置响应头
            response.setContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            response.setHeader("Content-Disposition", "attachment; filename=\"" + encodedFileName + "\"");
            response.setHeader("Cache-Control", "no-cache");

            // 7. 通过响应输出流写入Excel内容
            try (OutputStream os = response.getOutputStream()) {
                workbook.write(os);
                os.flush();
            } finally {
                workbook.close(); // 确保资源释放
            }

        } catch (IOException e) {
            e.printStackTrace();
            response.sendError(HttpServletResponse.SC_INTERNAL_SERVER_ERROR, "生成Excel文件失败: " + e.getMessage());
        }
    }

    // 设置行高（需在表头行创建后调用）
    private static void setRowHeights(Sheet sheet) {
        // 表头行高（3行）
        for (int i = 0; i < 3; i++) {
            if (sheet.getRow(i) != null) {
                sheet.getRow(i).setHeightInPoints(25);
            }
        }
    }

    // 添加基本信息表头
    private static int addBasicInfoHeaders(Sheet sheet, CellStyle headerStyle) {
        int rowIndex = 0;
        // 创建3级表头行
        Row row0 = sheet.createRow(rowIndex++);
        Row row1 = sheet.createRow(rowIndex++);
        Row row2 = sheet.createRow(rowIndex++);

        // 基本信息列标题
        String[] basicInfoLabels = {"序号", "日期", "通用名", "规格", "厂家", "单价（元）", "总分"};

        for (int i = 0; i < basicInfoLabels.length; i++) {
            // 设置标题
            Cell cell0 = row0.createCell(i);
            cell0.setCellValue(basicInfoLabels[i]);
            cell0.setCellStyle(headerStyle);

            // 合并行0-2的当前列
            sheet.addMergedRegion(new CellRangeAddress(0, 2, i, i));

            // 行1和行2创建单元格并应用样式
            Cell cell1 = row1.createCell(i);
            cell1.setCellStyle(headerStyle);
            Cell cell2 = row2.createCell(i);
            cell2.setCellStyle(headerStyle);
        }
        return rowIndex;
    }

    // 生成评分项多级表头
    private static void generateScoreHeaders(Sheet sheet, List<ScoreItem> items, CellStyle headerStyle, int startRow) {
        currentCol = BASIC_INFO_COL_COUNT; // 从基本信息列后开始
        Row row0 = sheet.getRow(0); // 一级表头
        Row row1 = sheet.getRow(1); // 二级表头
        Row row2 = sheet.getRow(2); // 三级表头

        for (ScoreItem item : items) {
            int columnCount = countColumns(item); // 一级项总列数

            // 处理一级表头
            Cell cell0 = row0.createCell(currentCol);
            cell0.setCellValue(item.getTitle() + "(" + item.getMaxScore() + ")");
            cell0.setCellStyle(headerStyle);

            // 仅当列数大于1时才合并
            if (columnCount > 1) {
                sheet.addMergedRegion(new CellRangeAddress(0, 0, currentCol, currentCol + columnCount - 1));
            }

            // 处理二级表头
            if (item.getChildren() != null && !item.getChildren().isEmpty()) {
                int childStartCol = currentCol;
                for (ScoreItem child : item.getChildren()) {
                    int childColCount = countColumns(child);
                    String level2Text = child.getTitle() + "(" + child.getMaxScore() + ")";

                    // 设置二级表头
                    Cell cell1 = row1.createCell(childStartCol);
                    cell1.setCellValue(level2Text);
                    cell1.setCellStyle(headerStyle);

                    // 处理三级表头
                    if (child.getChildren() != null && !child.getChildren().isEmpty()) {
                        // 有三级
                        if (childColCount > 1) {
                            sheet.addMergedRegion(new CellRangeAddress(1, 1, childStartCol, childStartCol + childColCount - 1));
                        }
                        // 填充三级表头
                        int grandChildStartCol = childStartCol;
                        for (ScoreItem grandChild : child.getChildren()) {
                            Cell cell2 = row2.createCell(grandChildStartCol);
                            cell2.setCellValue(grandChild.getTitle() + "(" + grandChild.getMaxScore() + ")");
                            cell2.setCellStyle(headerStyle);
                            grandChildStartCol++;
                        }
                    } else {
                        // 无三级
                        sheet.addMergedRegion(new CellRangeAddress(1, 2, childStartCol, childStartCol + childColCount - 1));
                        Cell cell2 = row2.createCell(childStartCol);
                        cell2.setCellStyle(headerStyle);
                    }
                    childStartCol += childColCount;
                }
            } else {
                // 无二级
                Cell cell1 = row1.createCell(currentCol);
                cell1.setCellValue(item.getTitle());
                cell1.setCellStyle(headerStyle);
                sheet.addMergedRegion(new CellRangeAddress(1, 2, currentCol, currentCol + columnCount - 1));
                Cell cell2 = row2.createCell(currentCol);
                cell2.setCellStyle(headerStyle);
            }
            currentCol += columnCount;
        }
    }

    // 填充数据行
    private static void fillDataRow(Sheet sheet, ListInfo drugInfo, int startRow, CellStyle dataStyle) {
        Row dataRow = sheet.createRow(startRow);
        dataRow.setHeightInPoints(20); // 设置数据行行高
        int dataCol = 0;

        // 处理厂家名称
        String spec = drugInfo.getSpecification();
        String manufacturer = drugInfo.getManufacturers() != null ? drugInfo.getManufacturers() : "";
        if (spec != null && !spec.isEmpty() && manufacturer.contains(spec + "-")) {
            manufacturer = manufacturer.replace(spec + "-", "");
        }

        // 基本信息数据
        String[] basicInfoValues = {
                String.valueOf(startRow - 2), // 序号（从1开始）
                new SimpleDateFormat("yyyy-MM-dd").format(new Date()), // 日期
                drugInfo.getDrugNames() != null ? drugInfo.getDrugNames() : "", // 通用名
                spec, // 规格
                manufacturer, // 厂家
                "", // 单价（需从数据源补充）
                String.valueOf(drugInfo.getTotalScore()) // 总分
        };

        // 填充基本信息
        for (String value : basicInfoValues) {
            Cell cell = dataRow.createCell(dataCol++);
            cell.setCellValue(value);
            cell.setCellStyle(dataStyle);
        }

        // 填充评分数据
        if (drugInfo.getContentlist() != null) {
            fillScoreData(dataRow, drugInfo.getContentlist(), dataCol, dataStyle);
        }
    }

    // 填充评分数据
    private static void fillScoreData(Row dataRow, List<ScoreItem> items, int startCol, CellStyle dataStyle) {
        int dataCol = startCol;
        for (ScoreItem item : items) {
            if (item.getChildren() != null) {
                for (ScoreItem child : item.getChildren()) {
                    if (child.getChildren() != null) {
                        for (ScoreItem grandChild : child.getChildren()) {
                            Cell cell = dataRow.createCell(dataCol);
                            cell.setCellValue(grandChild.getScore());
                            cell.setCellStyle(dataStyle);
                            dataCol++;
                        }
                    } else {
                        Cell cell = dataRow.createCell(dataCol);
                        cell.setCellValue(child.getScore());
                        cell.setCellStyle(dataStyle);
                        dataCol++;
                    }
                }
            } else {
                Cell cell = dataRow.createCell(dataCol);
                cell.setCellValue(item.getScore());
                cell.setCellStyle(dataStyle);
                dataCol++;
            }
        }
    }

    // 计算列数
    private static int countColumns(ScoreItem item) {
        if (item.getChildren() == null || item.getChildren().isEmpty()) {
            return 1;
        }
        int count = 0;
        for (ScoreItem child : item.getChildren()) {
            count += countColumns(child);
        }
        return count;
    }

    // 调整列宽
    private static void adjustColumnWidths(Sheet sheet) {
        // 基本信息列宽
        sheet.setColumnWidth(0, 8 * 256);  // 序号
        sheet.setColumnWidth(1, 12 * 256); // 日期
        sheet.setColumnWidth(2, 20 * 256); // 通用名
        sheet.setColumnWidth(3, 15 * 256); // 规格
        sheet.setColumnWidth(4, 30 * 256); // 厂家
        sheet.setColumnWidth(5, 12 * 256); // 单价
        sheet.setColumnWidth(6, 8 * 256);  // 总分

        // 评分项列宽
        for (int i = BASIC_INFO_COL_COUNT; i < currentCol; i++) {
            sheet.setColumnWidth(i, 18 * 256);
        }
    }

    // 创建表头样式
    private static CellStyle createHeaderStyle(Workbook workbook) {
        CellStyle style = workbook.createCellStyle();
        Font font = workbook.createFont();
        font.setBold(true);
        style.setFont(font);
        style.setAlignment(HorizontalAlignment.CENTER);
        style.setVerticalAlignment(VerticalAlignment.CENTER);
        style.setBorderTop(BorderStyle.THIN);
        style.setBorderBottom(BorderStyle.THIN);
        style.setBorderLeft(BorderStyle.THIN);
        style.setBorderRight(BorderStyle.THIN);
        style.setWrapText(true);
        return style;
    }

    // 创建数据样式
    private static CellStyle createDataStyle(Workbook workbook) {
        CellStyle style = workbook.createCellStyle();
        style.setAlignment(HorizontalAlignment.CENTER);
        style.setVerticalAlignment(VerticalAlignment.CENTER);
        style.setBorderTop(BorderStyle.THIN);
        style.setBorderBottom(BorderStyle.THIN);
        style.setBorderLeft(BorderStyle.THIN);
        style.setBorderRight(BorderStyle.THIN);
        return style;
    }






    // 获取JSON数据 - 实际应用中可从请求参数或服务接口获取
    private static String getJsonData() {
        return "{\n" +
                "    \"_id\": \"6879fc67d2b44719377c52ac\",\n" +
                "    \"listId\": \"3fd4e255-bc2e-4886-8726-944e8807f226\",\n" +
                "    \"listInfo\": [\n" +
                "        {\n" +
                "            \"drugNames\": \"乌帕替尼缓释片\",\n" +
                "            \"manufacturers\": \"乌帕替尼缓释片-AbbVie Deutschland GmbH & Co. KG\",\n" +
                "            \"title\": \"乌帕替尼缓释片-AbbVie Deutschland GmbH & Co. KG用于特应性皮炎\",\n" +
                "            \"contentlist\": [\n" +
                "                {\n" +
                "                    \"maxScore\": 28,\n" +
                "                    \"title\": \"药学特性\",\n" +
                "                    \"score\": 23.5,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"药理作用\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"体内过程\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 12,\n" +
                "                            \"title\": \"药剂学和使用方法（多选）\",\n" +
                "                            \"score\": 11,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"主要成分与辅料\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"规格与包装\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"剂型\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"给药剂量\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"给药频次\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"使用方便\",\n" +
                "                                    \"score\": 1\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 4,\n" +
                "                            \"title\": \"贮藏条件（多选）\",\n" +
                "                            \"score\": 3,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"贮藏条件\",\n" +
                "                                    \"score\": 3\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"药品有效期\",\n" +
                "                            \"score\": 1.5\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 27,\n" +
                "                    \"title\": \"有效性\",\n" +
                "                    \"score\": 23,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"适应症\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 12,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 12\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 10,\n" +
                "                            \"title\": \"临床疗效\",\n" +
                "                            \"score\": 6\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 25,\n" +
                "                    \"title\": \"安全性\",\n" +
                "                    \"score\": 18,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 8,\n" +
                "                            \"title\": \"不良反应（多选）\",\n" +
                "                            \"score\": 5,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 5,\n" +
                "                                    \"title\": \"安全性\",\n" +
                "                                    \"score\": 5\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 9,\n" +
                "                            \"title\": \"特殊人群（可多选）\",\n" +
                "                            \"score\": 6,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"儿童\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"老人\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"妊娠期妇女\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"哺乳期妇女\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"肝功能异常\",\n" +
                "                                    \"score\": 1\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"肾功能异常\",\n" +
                "                                    \"score\": 3\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"药物相互作用所致不良反应\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"其他（可多选）\",\n" +
                "                            \"score\": 2,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"安全性\",\n" +
                "                                    \"score\": 2\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 2\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 10,\n" +
                "                    \"title\": \"经济性\",\n" +
                "                    \"score\": 11,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"同通用名药品\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"主要适应证可替代药品\",\n" +
                "                            \"score\": 6\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 2\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 10,\n" +
                "                    \"title\": \"其他属性\",\n" +
                "                    \"score\": 9.6,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"国家医保\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"国家基本药物\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"国家集中采购药品\",\n" +
                "                            \"score\": 1\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"原研/参比/一致性评价\",\n" +
                "                            \"score\": 1\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"生产企业状况\",\n" +
                "                            \"score\": 0.6\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"全球使用情况\",\n" +
                "                            \"score\": 1\n" +
                "                        }\n" +
                "                    ]\n" +
                "                }\n" +
                "            ],\n" +
                "            \"totalScore\": 85.1,\n" +
                "            \"_class\": \"com.sentum.pojo.VaeDownJsonSimple\"\n" +
                "        },\n" +
                "        {\n" +
                "            \"drugNames\": \"乌帕替尼缓释片\",\n" +
                "            \"manufacturers\": \"乌帕替尼缓释片-AbbVie Deutschland GmbH & Co. KG\",\n" +
                "            \"title\": \"乌帕替尼缓释片-AbbVie Deutschland GmbH & Co. KG用于类风湿关节炎\",\n" +
                "            \"contentlist\": [\n" +
                "                {\n" +
                "                    \"maxScore\": 28,\n" +
                "                    \"title\": \"药学特性\",\n" +
                "                    \"score\": 26.5,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"药理作用\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"体内过程\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 12,\n" +
                "                            \"title\": \"药剂学和使用方法（多选）\",\n" +
                "                            \"score\": 11.5,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"主要成分与辅料\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"规格与包装\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"剂型\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"给药剂量\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"给药频次\",\n" +
                "                                    \"score\": 2\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"使用方便\",\n" +
                "                                    \"score\": 1.5\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 4,\n" +
                "                            \"title\": \"贮藏条件（多选）\",\n" +
                "                            \"score\": 3,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"贮藏条件\",\n" +
                "                                    \"score\": 3\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"药品有效期\",\n" +
                "                            \"score\": 2\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 27,\n" +
                "                    \"title\": \"有效性\",\n" +
                "                    \"score\": 27,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"适应症\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 12,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 12\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 10,\n" +
                "                            \"title\": \"临床疗效\",\n" +
                "                            \"score\": 10\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 25,\n" +
                "                    \"title\": \"安全性\",\n" +
                "                    \"score\": 14,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 8,\n" +
                "                            \"title\": \"不良反应（多选）\",\n" +
                "                            \"score\": 3,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 5,\n" +
                "                                    \"title\": \"安全性\",\n" +
                "                                    \"score\": 3\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 9,\n" +
                "                            \"title\": \"特殊人群（可多选）\",\n" +
                "                            \"score\": 4,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 2,\n" +
                "                                    \"title\": \"儿童\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"老人\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"妊娠期妇女\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 1,\n" +
                "                                    \"title\": \"哺乳期妇女\",\n" +
                "                                    \"score\": 0.5\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"肝功能异常\",\n" +
                "                                    \"score\": 1\n" +
                "                                },\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"肾功能异常\",\n" +
                "                                    \"score\": 1\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"药物相互作用所致不良反应\",\n" +
                "                            \"score\": 2\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"其他（可多选）\",\n" +
                "                            \"score\": 3,\n" +
                "                            \"children\": [\n" +
                "                                {\n" +
                "                                    \"maxScore\": 3,\n" +
                "                                    \"title\": \"安全性\",\n" +
                "                                    \"score\": 3\n" +
                "                                }\n" +
                "                            ]\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 2\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 10,\n" +
                "                    \"title\": \"经济性\",\n" +
                "                    \"score\": 10,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"同通用名药品\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 5,\n" +
                "                            \"title\": \"主要适应证可替代药品\",\n" +
                "                            \"score\": 5\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 2,\n" +
                "                            \"title\": \"文献推荐（若符合多条， 采用就高原则）\",\n" +
                "                            \"score\": 2\n" +
                "                        }\n" +
                "                    ]\n" +
                "                },\n" +
                "                {\n" +
                "                    \"maxScore\": 10,\n" +
                "                    \"title\": \"其他属性\",\n" +
                "                    \"score\": 9.8,\n" +
                "                    \"children\": [\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"国家医保\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 3,\n" +
                "                            \"title\": \"国家基本药物\",\n" +
                "                            \"score\": 3\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"国家集中采购药品\",\n" +
                "                            \"score\": 1\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"原研/参比/一致性评价\",\n" +
                "                            \"score\": 1\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"生产企业状况\",\n" +
                "                            \"score\": 0.8\n" +
                "                        },\n" +
                "                        {\n" +
                "                            \"maxScore\": 1,\n" +
                "                            \"title\": \"全球使用情况\",\n" +
                "                            \"score\": 1\n" +
                "                        }\n" +
                "                    ]\n" +
                "                }\n" +
                "            ],\n" +
                "            \"totalScore\": 87.3,\n" +
                "            \"_class\": \"com.sentum.pojo.VaeDownJsonSimple\"\n" +
                "        }\n" +
                "    ]\n" +
                "}";
    }
}
