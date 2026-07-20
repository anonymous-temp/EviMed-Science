package com.sentum.controller;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateUtil;
import com.alibaba.excel.EasyExcel;
import com.alibaba.excel.write.builder.ExcelWriterBuilder;
import com.alibaba.excel.write.builder.ExcelWriterSheetBuilder;
import com.alibaba.excel.write.handler.AbstractRowWriteHandler;
import com.alibaba.excel.write.metadata.holder.WriteSheetHolder;
import com.alibaba.excel.write.metadata.holder.WriteTableHolder;
import com.alibaba.excel.write.metadata.style.WriteCellStyle;
import com.alibaba.excel.write.metadata.style.WriteFont;
import com.alibaba.excel.write.style.HorizontalCellStyleStrategy;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.excel.bean.MedicineEvaluation;
import com.sentum.excel.bean.MedicineWmEvaluation;
import com.sentum.feign.ManageFeign;
import com.sentum.pojo.*;
import com.sentum.pojo.dto.CalculatedParameters;
import com.sentum.pojo.vo.DataResult;
import com.sentum.pojo.vo.SaveDrugPrice2;
import com.sentum.pojo.vo.TrCountVo;
import com.sentum.service.StreamService;
import com.sentum.service.StreamTrService;
import com.sentum.util.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.apache.poi.ss.usermodel.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

@Slf4j
@Api(tags = "快速综合评价API")
@RestController
@RequestMapping("/evaluation-api/stream")
public class StreamApiController {
    
    @Autowired
    private StreamService streamService;
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private StreamTrService streamTrService;
    @Autowired
    private ManageFeign manageFeign;

    @ApiOperation(value = "指南分析结果的检索 pharmacyScore-药学特性;effectivenessScore-有效性得分;safetyScore-安全性得分;economyScore-经济性;otherAttributesScore-其他属性", notes = "su-on-analysis")
    @PostMapping("/guide-on-analysis")
    public void guideOnAnalysis(@RequestBody StreamParams streamParams, HttpServletRequest request, HttpServletResponse response) {
        long userId = 0;
        String userName = "";
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
            userName = redisMap.get("userName").toString() + "---" + redisMap.get("phonenumber").toString();
        } catch (Exception e) {
            response.setStatus(401);
        }

        response.setContentType("text/event-stream");
        response.setCharacterEncoding("UTF-8");
        response.setHeader("Cache-Control", "no-cache");
        String[] split1 = streamParams.getDrugId().split(",");
        String[] split11 = streamParams.getDisease().split(";");
        for (String s1 : split11) {
            for (String s : split1) {
                String string = UUID.randomUUID().toString();
                try {
                    JSONObject dataJson = new JSONObject();
                    dataJson.put("report_id", string);
                    dataJson.put("user_id", userId);
                    dataJson.put("function", "药品遴选");
                    dataJson.put("module", "药学");
                    dataJson.put("report_name", "西药" + s + "治疗" + s1);
                    dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
                    manageFeign.addReportInfo(dataJson);
                } catch (Exception e) {
                    // report registration is best-effort; never fail the SSE flow
                    log.error("药品遴选添加异常" + e.getCause());
                }
                streamService.guidePanel(s, s1, streamParams.getSearchId(), userId, userName, response);
                DataResult.ok();
            }
        }
    }
    @ApiOperation(value = "", notes = "")
    @PostMapping("/guide-on-analysis-tr")
    public void guideOnAnalysisTr(@RequestBody StreamParams streamParams, HttpServletRequest request, HttpServletResponse response) {
        long userId = 0;
        String userName = "";
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
            userName = redisMap.get("userName").toString() + "---" + redisMap.get("phonenumber").toString();
        } catch (Exception e) {
            response.setStatus(401);
        }
        response.setContentType("text/event-stream");
        response.setCharacterEncoding("UTF-8");
        response.setHeader("Cache-Control", "no-cache");
        String[] split1 = streamParams.getDrugId().split(",");
        for (String s : split1) {
            String string = UUID.randomUUID().toString();
            try {
                JSONObject dataJson = new JSONObject();
                dataJson.put("report_id", string);
                dataJson.put("user_id", userId);
                dataJson.put("function", "药品遴选");
                dataJson.put("module", "药学");
                dataJson.put("report_name", "中成药" + s);
                dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
                manageFeign.addReportInfo(dataJson);
            } catch (Exception e) {
                log.error("药品遴选添加异常{}", e.getMessage(), e);
            }
            streamService.guidePanelTr(s, streamParams.getSearchId(), userName, response);
            DataResult.ok();
        }
    }
    @PostMapping("/saveAnalysis-tr")
    public DataResult saveAnalysisTr(@RequestBody List<JSONObject> jsonObject) {
        
        for (JSONObject jsonObject1 : jsonObject) {
            DrugInfoNew byId = mongoTemplate.findById(jsonObject1.getString("drugId"), DrugInfoNew.class);
            jsonObject1.put("drugInfo", byId.getDrugName() + "-" + byId.getSpecifications() + "-" + byId.getManufacturer());
            mongoTemplate.save(jsonObject1, "evaluation_cache");
        }

        List<ScoreTrData> scoreTrDatas = new ArrayList<>();
        for (JSONObject object : jsonObject) {
            if (StringUtils.isNotEmpty(object.getString("clinicalDemandOption"))) {
                switch (object.getString("clinicalDemandOption")) {
                    case "1":
                        object.put("clinicalDemandOption", "填补本院用药目录空白");
                        break;
                    case "2":
                        object.put("clinicalDemandOption", "可推动本院中医优势病种发展或可纳入临床路径");
                        break;
                    case "3":
                        object.put("clinicalDemandOption", "可为收治患者提供多种用药选择");
                        break;
                }
            } else {
                object.put("clinicalDemandOption", "暂无内容");
            }

            if (StringUtils.isNotEmpty(object.getString("packagingSpecificationOption"))) {
                switch (object.getString("packagingSpecificationOption")) {
                    case "1":

                        object.put("packagingSpecificationOption", "包装规格与临床常用日剂量适配(两者比值为整数)");
                        break;
                    case "2":

                        object.put("packagingSpecificationOption", "包装规格与临床常用日剂量适配(两者比值为非整数)");
                        break;

                }
            } else {
                object.put("packagingSpecificationOption", "暂无内容");
            }

            if (StringUtils.isNotEmpty(object.getString("largePackageAdoptionOption"))) {
                switch (object.getString("largePackageAdoptionOption")) {
                    case "1":
                        object.put("largePackageAdoptionOption", "最小包装使用人次数高于对照药");
                        break;
                    case "2":
                        object.put("largePackageAdoptionOption", "最小包装使用人次数低于对照药");
                        break;
                }
            } else {
                object.put("largePackageAdoptionOption", "暂无内容");
            }

            if (StringUtils.isNotEmpty(object.getString("singleDoseOption"))) {
                switch (object.getString("singleDoseOption")) {
                    case "1":

                        object.put("singleDoseOption", "临床常用单次用量与药品规格适配(两者比值为1)");
                        break;
                    case "2":

                        object.put("singleDoseOption", "临床常用单次用量与药品规格适配(两者比值>1)");
                        break;
                    case "3":

                        object.put("singleDoseOption", "临床常用单次用量与药品规格适配(两者比值<1)");
                        break;
                }
            } else {

                object.put("singleDoseOption", "暂无内容");
            }

            if (StringUtils.isNotEmpty(object.getString("marketUniquenessOption"))) {
                switch (object.getString("marketUniquenessOption")) {
                    case "1":

                        object.put("marketUniquenessOption", "具有不可替代的唯一性或填补市场空白");
                        break;
                    case "2":

                        object.put("marketUniquenessOption", "与已上市的同类药品相比具有独特优势");
                        break;
                    case "3":

                        object.put("marketUniquenessOption", "市面上有同类药品");
                        break;
                }
            } else {

                object.put("marketUniquenessOption", "暂无内容");
            }


            if (StringUtils.isNotEmpty(object.getString("dailyTreatmentCostOption"))) {
                switch (object.getString("dailyTreatmentCostOption")) {
                    case "1":
                        object.put("dailyTreatmentCostOption", "日均治疗费用较同类中成药价格较低");
                        break;
                    case "2":
                        object.put("dailyTreatmentCostOption", "日均治疗费用较同类中成药价格相当");
                        break;
                    case "3":
                        object.put("dailyTreatmentCostOption", "日均治疗费用较同类中成药价格高");
                        break;

                }
            } else {

                object.put("dailyTreatmentCostOption", "暂无内容");
            }


            String string1 = UUID.randomUUID().toString();
            ScoreTrData scoreTrData = JSON.parseObject(object.toString(), ScoreTrData.class);
            DrugInfoNew byId = mongoTemplate.findById(object.getString("drugId"), DrugInfoNew.class);
            scoreTrData.setDrugInfo(byId.getDrugName() + "-" + byId.getSpecifications() + "-" + byId.getManufacturer());


            String inheritanceEvaluationTotalScore = object.getString("inheritanceEvaluationTotalScore");
            String trClinicalEvaluationTotalScore = object.getString("trClinicalEvaluationTotalScore");
            String safetyEvaluationTotalScore = object.getString("safetyEvaluationTotalScore");
            String marketEvaluationTotalScore = object.getString("marketEvaluationTotalScore");
            String technologyEvaluationScore = object.getString("technologyEvaluationScore");


            scoreTrData.setInheritanceEvaluationTotalScore(inheritanceEvaluationTotalScore);
            scoreTrData.setTrClinicalEvaluationTotalScore(trClinicalEvaluationTotalScore);
            scoreTrData.setSafetyEvaluationTotalScore(safetyEvaluationTotalScore);
            scoreTrData.setMarketEvaluationTotalScore(marketEvaluationTotalScore);
            scoreTrData.setTechnologyEvaluationScore(technologyEvaluationScore);

            scoreTrData.setTotalScore();
            scoreTrData.setReportId(string1);
            scoreTrDatas.add(scoreTrData);
        }

        int i = 0;
        List<String> strings = new ArrayList<>();
        for (JSONObject object : jsonObject) {
            String reportId = scoreTrDatas.get(i).getReportId();
            object.put("drugInfo", scoreTrDatas.get(i).getDrugInfo());
            object.put("reportId", reportId);
            object.put("totalScore", scoreTrDatas.get(i).getTotalScore());
            i++;
            object.put("scoreList", scoreTrDatas);
            DrugInfoNew byId = mongoTemplate.findById(object.getString("drugId"), DrugInfoNew.class);
            object.put("simpleTitle", byId.getDrugName() + "综合评价报告");
            mongoTemplate.save(object, "drug_score_tra");
            strings.add(reportId);
        }
        return DataResult.data(strings);
    }
    @GetMapping("/getAnalysis-tr")
    @ApiImplicitParam(name = "reportId", value = "报告id", required = true, dataType = "String")
    public DataResult getAnalysisTr(@RequestParam String reportId) {
        JSONObject jsonObject = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(reportId)), JSONObject.class, "drug_score_tra");
        return DataResult.data(jsonObject);
    }
    // 页面计算
    @PostMapping("/count-tr")
    public DataResult countTr(@RequestBody CalculatedParameters calculatedParameters) {
        // 获取所有参数
        String packagQuantity = calculatedParameters.getPackagQuantity();
        String singleDose = calculatedParameters.getSingleDose();
        String medicationFrequency = calculatedParameters.getMedicationFrequency();
        String usageAndDosage = calculatedParameters.getUsageAndDosage();
        String pack = calculatedParameters.getPack();
        String specifications = calculatedParameters.getSpecifications();
        String price = calculatedParameters.getPrice();
        String miniQuantity = calculatedParameters.getMiniQuantity();
        Integer type = calculatedParameters.getType();

        TrCountVo trCountVo = new TrCountVo();
        if (type == 1) {
            double packagingSpecification = streamTrService.getPackagingSpecification(packagQuantity, singleDose, medicationFrequency, pack, usageAndDosage);
            if (packagingSpecification != 0.0) {
                boolean doubleInteger = streamTrService.isDoubleInteger(packagingSpecification);
                trCountVo.setDescription("包装规格与临床常用日剂量比值为" + packagingSpecification + "。");
                if (doubleInteger) {
                    trCountVo.setOffset("1");
                } else {
                    trCountVo.setOffset("2");
                }
            } else {
                trCountVo.setDescription("当前数据不足，请手动输入数值或直接勾选选项以完成评估。");
                trCountVo.setOffset("");
            }
        } else if (type == 2) {
            double largeNumber = streamTrService.getLargeNumber(packagQuantity, singleDose, usageAndDosage, pack);
            if (largeNumber != 0.0) {
                trCountVo.setDescription("该药品最小包装使用人次为" + largeNumber + "人·次。");
            } else {
                trCountVo.setDescription("当前数据不足，请手动输入数值或直接勾选选项以完成评估。");
            }
            trCountVo.setOffset("");

        } else if (type == 3) {
            double singleDose1 = streamTrService.getSingleDose(miniQuantity, singleDose, usageAndDosage, specifications);
            if (singleDose1 != 0.0) {
                trCountVo.setDescription("临床常用单次剂量与规格比值为" + singleDose1 + "。");
                if (singleDose1 == 1) {
                    trCountVo.setOffset("1");
                } else if (singleDose1 > 1) {
                    trCountVo.setOffset("2");
                } else if (singleDose1 < 1) {
                    trCountVo.setOffset("3");
                }
            } else {
                trCountVo.setDescription("当前数据不足，请手动输入数值或直接勾选选项以完成评估。");
                trCountVo.setOffset("");
            }
        } else if (type == 4) {
            double dailyTreatmentCost = streamTrService.getDailyTreatmentCost(singleDose, medicationFrequency, price);
            if (dailyTreatmentCost != 0.0) {
                trCountVo.setDescription("日均治疗费用为" + dailyTreatmentCost + "元");
            } else {
                trCountVo.setDescription("当前输入数据不足以计算日均治疗费用，请重新输入或手动勾选选项以完成经济性评估。");
            }
            trCountVo.setOffset("");
        }
        return DataResult.data(trCountVo);
    }
   

















    @GetMapping("/medicine-evaluation")
    public void exportMedicineEvaluationExcel(HttpServletResponse response, String reportId) {
        try {
            // 设置响应头
            response.setContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            response.setCharacterEncoding("utf-8");
            // 防止中文乱码

            // 获取现在的时间
            String time = System.currentTimeMillis() + "";
            // 截取最后四位
            time = time.substring(time.length() - 4);

            // 获取一般格式的时间,精确到天（年月日）
            String format = new SimpleDateFormat("yyyy-MM-dd").format(new Date());


            String fileName = URLEncoder.encode("中成药药品遴选评分细则-" + format + "-" + time + ".xlsx", "UTF-8").replaceAll("\\+", "%20");
            response.setHeader("Content-disposition", "attachment;filename*=utf-8''" + fileName);

            // 准备数据
            List<MedicineEvaluation> dataList = createSampleData(reportId, response);

            // 创建样式策略
            HorizontalCellStyleStrategy styleStrategy = createCellStyleStrategy();

            // 创建ExcelWriterBuilder并注册样式
            ExcelWriterBuilder writerBuilder = EasyExcel.write(response.getOutputStream(), MedicineEvaluation.class)
                    .registerWriteHandler(styleStrategy)
                    .registerWriteHandler(new CustomRowHeightHandler());


            // 创建Sheet并写入数据
            ExcelWriterSheetBuilder sheetBuilder = writerBuilder.sheet("中成药评价数据");
            sheetBuilder.doWrite(dataList);
        } catch (Exception e) {
            // 处理异常
            e.printStackTrace();
            try {
                response.reset();
                response.setContentType("application/json");
                response.setCharacterEncoding("utf-8");
                response.getWriter().println("{\"error\":\"导出失败：" + e.getMessage() + "\"}");
            } catch (Exception ex) {
                ex.printStackTrace();
            }
        }
    }


    @GetMapping("/medicine-evaluation-wm")
    public void exportMedicineEvaluationExcelWm(HttpServletResponse response, String reportId) {
        try {
            // 设置响应头
            response.setContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            response.setCharacterEncoding("utf-8");
            // 防止中文乱码

            // 获取现在的时间
            String time = System.currentTimeMillis() + "";
            // 截取最后四位
            time = time.substring(time.length() - 4);

            // 获取一般格式的时间,精确到天（年月日）
            String format = new SimpleDateFormat("yyyy-MM-dd").format(new Date());


            String fileName = URLEncoder.encode("西药药品遴选评分细则-" + format + "-" + time + ".xlsx", "UTF-8").replaceAll("\\+", "%20");
            response.setHeader("Content-disposition", "attachment;filename*=utf-8''" + fileName);

            // 准备数据
            List<MedicineWmEvaluation> dataList = createSampleDataWm(reportId, response);

            // 创建样式策略
            HorizontalCellStyleStrategy styleStrategy = createCellStyleStrategy();

            // 创建ExcelWriterBuilder并注册样式
            ExcelWriterBuilder writerBuilder = EasyExcel.write(response.getOutputStream(), MedicineWmEvaluation.class)
                    .registerWriteHandler(styleStrategy)
                    .registerWriteHandler(new CustomRowHeightHandler());


            // 创建Sheet并写入数据
            ExcelWriterSheetBuilder sheetBuilder = writerBuilder.sheet("中成药评价数据");
            sheetBuilder.doWrite(dataList);
        } catch (Exception e) {
            // 处理异常
            e.printStackTrace();
            try {
                response.reset();
                response.setContentType("application/json");
                response.setCharacterEncoding("utf-8");
                response.getWriter().println("{\"error\":\"导出失败：" + e.getMessage() + "\"}");
            } catch (Exception ex) {
                ex.printStackTrace();
            }
        }
    }


    /**
     * 自定义行高处理器
     */
    private static class CustomRowHeightHandler extends AbstractRowWriteHandler {
        @Override
        public void afterRowCreate(WriteSheetHolder writeSheetHolder, WriteTableHolder writeTableHolder, Row row, Integer relativeRowIndex, Boolean isHead) {
            Sheet sheet = writeSheetHolder.getSheet();

            if (isHead) {
                // 处理表头行高
                if (row.getRowNum() == 0 || row.getRowNum() == 1) {
                    // 第1、2行表头（较低行高）
                    row.setHeightInPoints(30);
                } else if (row.getRowNum() == 2) {
                    // 第3行表头（较高行高）
                    row.setHeightInPoints(30);
                }
            } else {
                // 处理数据行高（正文）
                row.setHeightInPoints(30); // 增加正文行高
            }
        }
    }


    @GetMapping("/getExcel")
    public void getExcel(HttpServletResponse response, String drug) {
        List<DrugInfoNew> register = mongoTemplate.find(new Query(Criteria.where("register").is(drug)), DrugInfoNew.class);
        String id = register.get(0).getId();

// 使用线程池执行任务
        ExecutorService executorService = Executors.newFixedThreadPool(10);
        List<Future<JSONObject>> futures = new ArrayList<>();

// 提交10个任务到线程池
        for (int i = 0; i < 10; i++) {
            final int index = i;
            Future<JSONObject> future = executorService.submit(() -> {
                Object result = streamService.guidePanelTr(id, null, "userName", null);
                return JSONObject.parseObject(result.toString());
            });
            futures.add(future);
        }

// 等待所有任务完成并收集结果
        ArrayList<JSONObject> jsonObjects = new ArrayList<>();
        for (Future<JSONObject> future : futures) {
            try {
                JSONObject jsonObject = future.get();
                jsonObjects.add(jsonObject);
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

// 关闭线程池
        executorService.shutdown();

// 数据集合
        List<MedicineEvaluation> dataList = new ArrayList<>();


        for (JSONObject jsonObject : jsonObjects) {
            JSONObject object = new JSONObject();
            JSONArray jsonArray = jsonObject.getJSONArray("info");
            for (JSONObject jsonObject1 : jsonArray.toJavaList(JSONObject.class)) {
                // 所有key与
                String o1 = jsonObject1.getString("key");
                Object o2 = jsonObject1.get("value");
                object.put(o1, o2);
            }
            MedicineEvaluation javaObject = JSON.toJavaObject(object, MedicineEvaluation.class);
            // 获取总分
            Double inheritanceEvaluationTotalScore = object.getDouble("inheritanceEvaluationTotalScore");

            Double trClinicalEvaluationTotalScore = object.getDouble("trClinicalEvaluationTotalScore");

            Double safetyEvaluationTotalScore = object.getDouble("safetyEvaluationTotalScore");

            Double trTechnicalEvaluationTotalScore = object.getDouble("technologyEvaluationScore");

            Double trMarketEvaluationTotalScore = object.getDouble("marketEvaluationTotalScore");

            double v = inheritanceEvaluationTotalScore + trClinicalEvaluationTotalScore + safetyEvaluationTotalScore + trTechnicalEvaluationTotalScore + trMarketEvaluationTotalScore;

            // 总分
            javaObject.setTotalScore(String.valueOf(v));

            dataList.add(javaObject);
        }


        try {
            // 设置响应头
            response.setContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            response.setCharacterEncoding("utf-8");
            // 防止中文乱码

            // 获取现在的时间
            String time = System.currentTimeMillis() + "";
            // 截取最后四位
            time = time.substring(time.length() - 4);

            // 获取一般格式的时间,精确到天（年月日）
            String format = new SimpleDateFormat("yyyy-MM-dd").format(new Date());


            String fileName = URLEncoder.encode("中成药药品遴选评分细则-" + register.get(0).getDrugName() + "-" + time + ".xlsx", "UTF-8").replaceAll("\\+", "%20");
            response.setHeader("Content-disposition", "attachment;filename*=utf-8''" + fileName);


            // 创建样式策略
            HorizontalCellStyleStrategy styleStrategy = createCellStyleStrategy();

            // 创建ExcelWriterBuilder并注册样式
            ExcelWriterBuilder writerBuilder = EasyExcel.write(response.getOutputStream(), MedicineEvaluation.class)
                    .registerWriteHandler(styleStrategy)
                    .registerWriteHandler(new CustomRowHeightHandler());


            // 创建Sheet并写入数据
            ExcelWriterSheetBuilder sheetBuilder = writerBuilder.sheet("中成药评价数据");
            sheetBuilder.doWrite(dataList);
        } catch (Exception e) {
            // 处理异常
            e.printStackTrace();
            try {
                response.reset();
                response.setContentType("application/json");
                response.setCharacterEncoding("utf-8");
                response.getWriter().println("{\"error\":\"导出失败：" + e.getMessage() + "\"}");
            } catch (Exception ex) {
                ex.printStackTrace();
            }
        }


    }




    @GetMapping("/getInt")
    public void getInt(){
        List<String> drugApprovals = new ArrayList<>();

        // drugApprovals.add("国药准字Z20026439");
        // drugApprovals.add("国药准字Z20103032");
        // drugApprovals.add("国药准字Z12020589");
        // drugApprovals.add("国药准字Z20030096");
        // drugApprovals.add("国药准字Z53020136");
        // drugApprovals.add("国药准字Z44020284");
        // drugApprovals.add("国药准字Z20026866");
        // drugApprovals.add("国药准字Z53021569");
        // drugApprovals.add("国药准字Z20000022");
        // drugApprovals.add("国药准字Z10980058");
        // drugApprovals.add("国药准字Z11020385");
        // drugApprovals.add("国药准字Z20033237");
        // drugApprovals.add("国药准字Z20080280");
        // drugApprovals.add("国药准字Z20049007");
        // drugApprovals.add("国药准字Z44020045");
        // drugApprovals.add("国药准字Z20083065");
        // drugApprovals.add("国药准字Z10920027");
        // drugApprovals.add("国药准字Z53021547");
        // drugApprovals.add("国药准字Z20163112");
        // drugApprovals.add("国药准字Z10910036");
        // drugApprovals.add("国药准字Z44021186");
        // drugApprovals.add("国药准字Z61020168");
        // drugApprovals.add("国药准字Z20163050");
        // drugApprovals.add("国药准字Z34020284");
        // drugApprovals.add("国药准字Z10970036");
        // drugApprovals.add("国药准字Z20027144");
        // drugApprovals.add("国药准字Z20030017");
        // drugApprovals.add("国药准字Z10970056");
        // drugApprovals.add("国药准字Z12020223");
        // drugApprovals.add("国药准字Z19990040");
        // drugApprovals.add("国药准字Z20027411");
        drugApprovals.add("国药准字Z43020138");
        drugApprovals.add("国药准字Z20090035");
        drugApprovals.add("国药准字Z20080033");
        drugApprovals.add("国药准字Z10970026");
        drugApprovals.add("国药准字Z10950075");
        drugApprovals.add("国药准字Z20050845");
        drugApprovals.add("国药准字Z20020073");
        drugApprovals.add("国药准字Z19991011");
        drugApprovals.add("国药准字Z20010098");
        drugApprovals.add("国药准字Z20043267");
        drugApprovals.add("国药准字Z20025173");
        drugApprovals.add("国药准字Z51022475");
        drugApprovals.add("国药准字Z13020887");
        drugApprovals.add("国药准字Z13020889");
        drugApprovals.add("国药准字Z20060463");
        drugApprovals.add("国药准字Z10940034");
        drugApprovals.add("国药准字Z20090250");
        drugApprovals.add("国药准字Z20073256");
        drugApprovals.add("国药准字Z20030052");
        drugApprovals.add("国药准字Z13020772");
        drugApprovals.add("国药准字Z10960004");
        drugApprovals.add("国药准字Z20025660");


        ArrayList<String> strings = new ArrayList<>();
        ArrayList<String> strings1 = new ArrayList<>();


        for (String drugApproval : drugApprovals) {
            try {
                exportToLocal1(drugApproval);
                strings.add(drugApproval);
                log.info("成功导出{}",drugApproval);
            } catch (Exception e) {

                log.error("错误信息：{}",    e.getMessage());
                log.error("报错药品为:{}",drugApproval);
                strings1.add(drugApproval);
            }
        }

        log.info("成功：{}",strings);
        log.info("失败：{}",strings1);

    }



    @GetMapping("/getExcelX1")
    public void exportToLocal1(String drug) {
        // 查询药品信息
        List<DrugInfoNew> register = mongoTemplate.find(new Query(Criteria.where("register").is(drug)), DrugInfoNew.class);
        if (register == null || register.isEmpty()) {
            throw new RuntimeException("未查询到药品信息: " + drug);
        }
        String id = register.get(0).getId();


        DrugInfoNew drugInfoNew = register.get(0);
        String drugName = drugInfoNew.getDrugName();
        String manufacturer = drugInfoNew.getManufacturer();
        String specifications = drugInfoNew.getSpecifications();

        Criteria criteria = new Criteria();
        criteria = new Criteria().andOperator(
                Criteria.where("commonName").is(drugName),
                Criteria.where("manufacturer").is(manufacturer),
                Criteria.where("specification").is(specifications)
        );
        Query query = new Query(criteria);
        List<MedicineEvaluation> medicineEvaluations = mongoTemplate.find(query, MedicineEvaluation.class, "evaluation_excel_tr");
        if (CollUtil.isEmpty(medicineEvaluations)){
             medicineEvaluations = mongoTemplate.find(query, MedicineEvaluation.class, "evaluation_excel_tr_x");
        }

        if (medicineEvaluations.size()>10){
            medicineEvaluations = medicineEvaluations.subList(0, 10);
        }


        if (medicineEvaluations.size() ==10){
            int i = 0;
            for (MedicineEvaluation medicineEvaluation : medicineEvaluations) {
                //添加编号
                medicineEvaluation.setSerialNumber(i+1+"");
                i++;
                 mongoTemplate.save(medicineEvaluation, "drug_evaluation_excel_10");

            }

        }else {

            int size = medicineEvaluations.size();


            String time = System.currentTimeMillis() + "";
            time = time.substring(time.length() - 4);
            String format = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd"));

           do {
               try {
                   Object jsonObjectx = streamService.guidePanelTr(id, null, "userName", null);
                   JSONObject jsonObject = JSONObject.parseObject(jsonObjectx.toString());


                   JSONObject object = new JSONObject();
                   JSONArray jsonArray = jsonObject.getJSONArray("info");
                   for (JSONObject jsonObject1 : jsonArray.toJavaList(JSONObject.class)) {
                       String o1 = jsonObject1.getString("key");
                       Object o2 = jsonObject1.get("value");
                       object.put(o1, o2);
                   }
                   MedicineEvaluation javaObject = JSON.toJavaObject(object, MedicineEvaluation.class);
                   // 计算总分
                   Double inheritanceEvaluationTotalScore = object.getDouble("inheritanceEvaluationTotalScore");
                   Double trClinicalEvaluationTotalScore = object.getDouble("trClinicalEvaluationTotalScore");
                   Double safetyEvaluationTotalScore = object.getDouble("safetyEvaluationTotalScore");
                   Double trTechnicalEvaluationTotalScore = object.getDouble("technologyEvaluationScore");
                   Double trMarketEvaluationTotalScore = object.getDouble("marketEvaluationTotalScore");

                   double totalScore = inheritanceEvaluationTotalScore + trClinicalEvaluationTotalScore +
                           safetyEvaluationTotalScore + trTechnicalEvaluationTotalScore +
                           trMarketEvaluationTotalScore;

                   javaObject.setTotalScore(String.valueOf(totalScore));

                   javaObject.setDate(format);

                   javaObject.setManufacturer(register.get(0).getManufacturer());
                   javaObject.setSpecification(register.get(0).getSpecifications());
                   javaObject.setCommonName(register.get(0).getDrugName());


                   try {
                       if (object.getDouble("diseaseCombinationScore1")>3){
                           javaObject.setDiseaseCombinationScore("5.0");
                           javaObject.setDiseaseCombinationScore1("");




                       }else if (object.getDouble("diseaseCombinationScore1")>2){
                           javaObject.setDiseaseCombinationScore("");
                           javaObject.setDiseaseCombinationScore1("3.0");

                       }else {
                           javaObject.setDiseaseCombinationScore("");
                           javaObject.setDiseaseCombinationScore1("");

                       }
                   } catch (Exception e) {
                       javaObject.setDiseaseCombinationScore("");
                       javaObject.setDiseaseCombinationScore1("");
                   }

                   size++;
                   medicineEvaluations.add(javaObject);
               } catch (Exception e) {

               }

           }while (size<10);

           int i = 0;
           for (MedicineEvaluation medicineEvaluation : medicineEvaluations) {

               //添加编号
               medicineEvaluation.setSerialNumber(i+1+"");
               i++;

                mongoTemplate.save(medicineEvaluation, "drug_evaluation_excel_10");
           }


        }





        // try {
        //     // 本地保存路径（空着，可根据需要修改）
        //     String localDir = "C:/Users/Administrator/Desktop/53个药品excel"; // 这里是本地目录，例如："D:/药品数据导出/"
        //
        //     // 确保目录存在
        //     if (!localDir.isEmpty()) {
        //         File dir = new File(localDir);
        //         if (!dir.exists()) {
        //             dir.mkdirs();
        //         }
        //     }
        //
        //     // 文件名处理
        //
        //     String fileName = "中成药药品遴选评分细则-" + register.get(0).getDrugName() + "-" + time + ".xlsx";
        //
        //     // 完整文件路径
        //     String filePath = localDir.isEmpty() ? fileName : localDir + File.separator + fileName;
        //
        //     // 创建样式策略
        //     HorizontalCellStyleStrategy styleStrategy = createCellStyleStrategy();
        //
        //     // 写入本地文件
        //     try (ExcelWriter writer = EasyExcel.write(filePath, MedicineEvaluation.class)
        //             .registerWriteHandler(styleStrategy)
        //             .registerWriteHandler(new CustomRowHeightHandler())
        //             .build()) {
        //         WriteSheet sheet = EasyExcel.writerSheet("中成药评价数据").build();
        //         writer.write(dataList, sheet);
        //     }
        //
        //     System.out.println("文件已成功导出到: " + new File(filePath).getAbsolutePath());
        //
        // } catch (Exception e) {
        //     e.printStackTrace();
        //     System.err.println("导出失败: " + e.getMessage());
        // }
    }




    @GetMapping("/getExcelX")
    public void exportToLocal(String drug) {
        // 查询药品信息
        List<DrugInfoNew> register = mongoTemplate.find(new Query(Criteria.where("register").is(drug)), DrugInfoNew.class);
        if (register == null || register.isEmpty()) {
            throw new RuntimeException("未查询到药品信息: " + drug);
        }
        String id = register.get(0).getId();

        // 使用线程池执行任务
        ExecutorService executorService = Executors.newFixedThreadPool(10);
        List<Future<JSONObject>> futures = new ArrayList<>();

        // 提交10个任务到线程池
        for (int i = 0; i < 10; i++) {
            Future<JSONObject> future = executorService.submit(() -> {
                Object result = streamService.guidePanelTr(id, null, "userName", null);
                return JSONObject.parseObject(result.toString());
            });
            futures.add(future);
        }

        // 等待所有任务完成并收集结果
        ArrayList<JSONObject> jsonObjects = new ArrayList<>();
        for (Future<JSONObject> future : futures) {
            try {
                JSONObject jsonObject = future.get();
                jsonObjects.add(jsonObject);
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        // 关闭线程池
        executorService.shutdown();

        // 数据集合
        List<MedicineEvaluation> dataList = new ArrayList<>();

        String time = System.currentTimeMillis() + "";
        time = time.substring(time.length() - 4);
        String format = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd"));

        for (JSONObject jsonObject : jsonObjects) {
            JSONObject object = new JSONObject();
            JSONArray jsonArray = jsonObject.getJSONArray("info");
            for (JSONObject jsonObject1 : jsonArray.toJavaList(JSONObject.class)) {
                String o1 = jsonObject1.getString("key");
                Object o2 = jsonObject1.get("value");
                object.put(o1, o2);
            }
            MedicineEvaluation javaObject = JSON.toJavaObject(object, MedicineEvaluation.class);
            // 计算总分
            Double inheritanceEvaluationTotalScore = object.getDouble("inheritanceEvaluationTotalScore");
            Double trClinicalEvaluationTotalScore = object.getDouble("trClinicalEvaluationTotalScore");
            Double safetyEvaluationTotalScore = object.getDouble("safetyEvaluationTotalScore");
            Double trTechnicalEvaluationTotalScore = object.getDouble("technologyEvaluationScore");
            Double trMarketEvaluationTotalScore = object.getDouble("marketEvaluationTotalScore");

            double totalScore = inheritanceEvaluationTotalScore + trClinicalEvaluationTotalScore +
                    safetyEvaluationTotalScore + trTechnicalEvaluationTotalScore +
                    trMarketEvaluationTotalScore;

            javaObject.setTotalScore(String.valueOf(totalScore));

            javaObject.setDate(format);

            javaObject.setManufacturer(register.get(0).getManufacturer());
            javaObject.setSpecification(register.get(0).getSpecifications());
            javaObject.setCommonName(register.get(0).getDrugName());



            try {
                if (object.getDouble("diseaseCombinationScore1")>3){
                    javaObject.setDiseaseCombinationScore("5.0");
                    javaObject.setDiseaseCombinationScore1("");




                }else if (object.getDouble("diseaseCombinationScore1")>2){
                    javaObject.setDiseaseCombinationScore("");
                    javaObject.setDiseaseCombinationScore1("3.0");

                }else {
                    javaObject.setDiseaseCombinationScore("");
                    javaObject.setDiseaseCombinationScore1("");

                }
            } catch (Exception e) {
                javaObject.setDiseaseCombinationScore("");
                javaObject.setDiseaseCombinationScore1("");
            }


            mongoTemplate.save(javaObject, "evaluation_excel_tr");
        }




        // try {
        //     // 本地保存路径（空着，可根据需要修改）
        //     String localDir = "C:/Users/Administrator/Desktop/53个药品excel"; // 这里是本地目录，例如："D:/药品数据导出/"
        //
        //     // 确保目录存在
        //     if (!localDir.isEmpty()) {
        //         File dir = new File(localDir);
        //         if (!dir.exists()) {
        //             dir.mkdirs();
        //         }
        //     }
        //
        //     // 文件名处理
        //
        //     String fileName = "中成药药品遴选评分细则-" + register.get(0).getDrugName() + "-" + time + ".xlsx";
        //
        //     // 完整文件路径
        //     String filePath = localDir.isEmpty() ? fileName : localDir + File.separator + fileName;
        //
        //     // 创建样式策略
        //     HorizontalCellStyleStrategy styleStrategy = createCellStyleStrategy();
        //
        //     // 写入本地文件
        //     try (ExcelWriter writer = EasyExcel.write(filePath, MedicineEvaluation.class)
        //             .registerWriteHandler(styleStrategy)
        //             .registerWriteHandler(new CustomRowHeightHandler())
        //             .build()) {
        //         WriteSheet sheet = EasyExcel.writerSheet("中成药评价数据").build();
        //         writer.write(dataList, sheet);
        //     }
        //
        //     System.out.println("文件已成功导出到: " + new File(filePath).getAbsolutePath());
        //
        // } catch (Exception e) {
        //     e.printStackTrace();
        //     System.err.println("导出失败: " + e.getMessage());
        // }
    }



    /**
     * 创建示例数据
     */
    private List<MedicineEvaluation> createSampleData(String reportId, HttpServletResponse response) {
        List<MedicineEvaluation> list = new ArrayList<>();
        JSONObject jsonObject = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(reportId)), JSONObject.class, "drug_score_tra");
        JSONArray scoreList = jsonObject.getJSONArray("scoreList");
        int x = 0;
        for (JSONObject o : scoreList.toJavaList(JSONObject.class)) {
            MedicineEvaluation medicineEvaluation = JSONObject.parseObject(o.toJSONString(), MedicineEvaluation.class);
            // 设置其他字段的值
            // 序号
            medicineEvaluation.setSerialNumber(x + 1 + "");
            x++;

            // 药品想抢
            String drugInfo = o.getString("drugInfo");
            if (drugInfo != null) {
                String[] split = drugInfo.split("-");
                if (split.length == 3) {
                    medicineEvaluation.setCommonName(split[0]);
                    medicineEvaluation.setSpecification(split[1]);
                    medicineEvaluation.setManufacturer(split[2]);
                }
            }

            double v = 0;
            try {
                v = Double.parseDouble(medicineEvaluation.getDiseaseCombinationScore1());
            } catch (Exception e) {

            }

            if (v > 3) {
                medicineEvaluation.setDiseaseCombinationScore(medicineEvaluation.getDiseaseCombinationScore1());
                medicineEvaluation.setDiseaseCombinationScore1("0");
            } else if (v <= 3) {
                medicineEvaluation.setDiseaseCombinationScore("0");
                medicineEvaluation.setDiseaseCombinationScore1(medicineEvaluation.getDiseaseCombinationScore1());
            } else {
                medicineEvaluation.setDiseaseCombinationScore("0");
                medicineEvaluation.setDiseaseCombinationScore1("0");
            }

            // 保护品种
            if ("1".equals(medicineEvaluation.getNationalTraditionalChineseMedicineProtectionScore())) {
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore("0");
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore1("0");
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore2("1");
            } else if ("2".equals(medicineEvaluation.getNationalTraditionalChineseMedicineProtectionScore())) {
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore("0");
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore1("2");
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore2("0");
            } else if ("3".equals(medicineEvaluation.getNationalTraditionalChineseMedicineProtectionScore())) {
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore("3");
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore1("0");
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore2("0");
            } else {
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore("0");
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore1("0");
                medicineEvaluation.setNationalTraditionalChineseMedicineProtectionScore2("1");
            }


            // 获取一般格式的时间,精确到天（年月日）
            String format = new SimpleDateFormat("yyyy-MM-dd").format(new Date());

            medicineEvaluation.setDate(format);

//            //用户名
//            //获取token
//            String token = o.getString("token");
//            if (com.alibaba.excel.util.StringUtils.isNotBlank(token)){
//                SysUser userByToken = new UserUtil().getUserByToken(token);
//                medicineEvaluation.setEvaluator(userByToken.getUserName());
//
//            }

            list.add(medicineEvaluation);

        }


        return list;
    }


    private List<MedicineWmEvaluation> createSampleDataWm(String reportId, HttpServletResponse response) {
        List<MedicineWmEvaluation> list = new ArrayList<>();
        JSONObject jsonObject = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(reportId)), JSONObject.class, "drug_score_tra");
        JSONArray scoreList = jsonObject.getJSONArray("scoreList");
        int x = 0;
        for (JSONObject o : scoreList.toJavaList(JSONObject.class)) {
            MedicineWmEvaluation medicineEvaluation = JSONObject.parseObject(o.toJSONString(), MedicineWmEvaluation.class);
            // 设置其他字段的值
            // 序号
            medicineEvaluation.setSerialNumber(x + 1 + "");
            x++;

            // 药品想抢
            String drugInfo = o.getString("drugInfo");
            if (drugInfo != null) {
                String[] split = drugInfo.split("-");
                if (split.length == 3) {
                    medicineEvaluation.setGenericName(split[0]);
                    medicineEvaluation.setSpecification(split[1]);
                    medicineEvaluation.setManufacturer(split[2]);
                }
            }
            medicineEvaluation.setAll();

            list.add(medicineEvaluation);

        }


        return list;
    }


    @PostMapping("/getPriceScore")
    public DataResult getPriceScore(@RequestBody SaveDrugPrice2 saveDrugPrice) {
        return DataResult.data(streamService.economicalAnalysis(saveDrugPrice));
    }


    @PostMapping("/saveAnalysis")
    public DataResult saveAnalysis(@RequestBody List<JSONObject> jsonObject) {
        ArrayList<ScoreData> scoreData = new ArrayList<>();
        for (JSONObject object : jsonObject) {
            String randomUUID = UUID.randomUUID().toString();
            ScoreData score = JSON.parseObject(object.toString(), ScoreData.class);
            SaveDrugPrice2 saveDrugPrice = JSON.parseObject(object.toString(), SaveDrugPrice2.class);
            EconomicalVo s = streamService.economicalAnalysisPlus(saveDrugPrice);
            score.setEconomicScore(s.getEconomicalScore());
            score.setEconomicScore1(s.getEconomicScore1());
            score.setEconomicScore2(s.getEconomicScore2());

            score.setReportId(randomUUID);
            score.setTotalScore();
            DrugInfoNew byId = mongoTemplate.findById(object.getString("drugId"), DrugInfoNew.class);
            score.setDrugInfo(byId.getDrugName() + "-" + byId.getSpecifications() + "-" + byId.getManufacturer());
            scoreData.add(score);
        }

        int i = 0;
        ArrayList<SaveAnalysisResult> strings = new ArrayList<>();
        for (JSONObject jsonObject1 : jsonObject) {
            String randomUUID = scoreData.get(i).getReportId();
            i++;
            jsonObject1.put("reportId", randomUUID);
            SaveDrugPrice2 saveDrugPrice = JSON.parseObject(jsonObject1.toString(), SaveDrugPrice2.class);
            EconomicalVo s = streamService.economicalAnalysisPlus(saveDrugPrice);
            ScoreData score = JSON.parseObject(jsonObject1.toString().toString(), ScoreData.class);
            score.setEconomicScore(s.getEconomicalScore());
            score.setTotalScore();
            jsonObject1.put("totalScore", score.getTotalScore());
            String status = "";
            Double value = Double.valueOf(score.getTotalScore());
            if (value > 70) {
                status = "强推荐";
                jsonObject1.put("recommendation", "临床上治疗" + jsonObject1.getString("disease") + "：用于新品引进时，建议为" + status + "；用于药品调出时，建议为保留。");
            } else if (value < 60) {
                status = "不推荐";
                jsonObject1.put("recommendation", "临床上治疗" + jsonObject1.getString("disease") + "：用于新品引进时，建议为" + status + "；用于药品调出时，建议为调出。");
            } else {
                status = "弱推荐";
                jsonObject1.put("recommendation", "临床上治疗" + jsonObject1.getString("disease") + "：用于新品引进时，根据临床是否有替代治疗药物，建议为" + status + "或不推荐；用于药品调出时，根据临床是否有替代治疗药物，建议为暂时保留或调出。");
            }
            jsonObject1.put("status", status);
            jsonObject1.put("economicScore", s.getEconomicalScore());
            jsonObject1.put("economicScore1", s.getEconomicScore1());
            jsonObject1.put("economicScore2", s.getEconomicScore2());

            jsonObject1.put("economic1", s.getEconomical1());
            jsonObject1.put("economic2", s.getEconomical2());
            jsonObject1.put("scoreList", scoreData);
            String string = jsonObject1.getString("drugId");
            DrugInfoNew byId = mongoTemplate.findById(string, DrugInfoNew.class);
            jsonObject1.put("simpleTitle", byId.getDrugName() + "用于" + jsonObject1.getString("disease") + "综合评价报告");
            jsonObject1.put("drugInfo", byId.getDrugName() + "-" + byId.getSpecifications() + "-" + byId.getManufacturer());
            jsonObject1.put("title", byId.getDrugName() + "用于" + jsonObject1.getString("disease"));
            mongoTemplate.save(jsonObject1, "drug_score_tra");
            jsonObject1.put("economicalScore", s.getEconomicalScore());
            SaveAnalysisResult saveAnalysisResult = new SaveAnalysisResult(randomUUID, s.getEconomicalScore());
            strings.add(saveAnalysisResult);
        }
        return DataResult.data(strings);
    }


    @GetMapping("/getAnalysis")
    @ApiImplicitParam(name = "reportId", value = "报告id", required = true, dataType = "String")
    public DataResult getAnalysis(@RequestParam String reportId) {
        JSONObject jsonObject = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(reportId)), JSONObject.class, "drug_score_tra");
        return DataResult.data(jsonObject);
    }


   


    

    


    


    /**
     * 创建单元格样式策略（适配新版EasyExcel）
     */
    private HorizontalCellStyleStrategy createCellStyleStrategy() {
        // 表头样式
        WriteCellStyle headStyle = new WriteCellStyle();
        WriteFont headFont = new WriteFont();
        headFont.setFontName("宋体");
        headFont.setFontHeightInPoints((short) 10);
        headFont.setBold(true);
        headStyle.setWriteFont(headFont);

        headStyle.setHorizontalAlignment(HorizontalAlignment.CENTER);
        headStyle.setVerticalAlignment(VerticalAlignment.CENTER);
        headStyle.setWrapped(true);
        headStyle.setFillPatternType(FillPatternType.NO_FILL);


        // 内容样式
        WriteCellStyle contentStyle = new WriteCellStyle();
        WriteFont contentFont = new WriteFont();
        contentFont.setFontName("宋体");
        contentFont.setFontHeightInPoints((short) 10);
        contentStyle.setWriteFont(contentFont);

        contentStyle.setHorizontalAlignment(HorizontalAlignment.CENTER);
        contentStyle.setVerticalAlignment(VerticalAlignment.CENTER);
        contentStyle.setWrapped(true);

        return new HorizontalCellStyleStrategy(headStyle, contentStyle);
    }


}
