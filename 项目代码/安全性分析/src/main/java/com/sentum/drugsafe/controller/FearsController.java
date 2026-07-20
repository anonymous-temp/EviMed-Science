package com.sentum.drugsafe.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.pojo.AdverseForCaseIndex;
import com.sentum.drugsafe.pojo.AdverseIndex;
import com.sentum.drugsafe.service.FearsChoose;
import com.sentum.drugsafe.service.FearsService;
import com.sentum.drugsafe.utils.FearsMongoUtil;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.IndexOperations;
import org.springframework.data.mongodb.core.BulkOperations;
import org.springframework.data.mongodb.core.aggregation.Aggregation;
import org.springframework.data.mongodb.core.aggregation.AggregationOptions;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.*;
import java.util.stream.Collectors;


@Slf4j
@RestController
@RequestMapping("/fears")
public class FearsController {


    @Autowired
    private FearsService fearsServiceImpl;

    @Autowired
    private FearsMongoUtil mongoUtil;

    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;

    @Autowired
    @Qualifier("fearsChooseImpl1")
    private FearsChoose fearsChoose;


    //写入drug
    @GetMapping("/drug")
    public void drug(String filePath, String databaseName, HttpServletResponse response) {
        fearsServiceImpl.getDrug(filePath, databaseName, response);
    }

    @GetMapping("/drug/write")
    public void drugWrite(HttpServletResponse response, String name) {


        for (int year = 2004; year <= 2012; year++) {
            for (int month = 1; month <= 4; month++) {
                String yearx = String.valueOf(year).substring(2, 4);


                String filename = name + yearx + "Q" + month + ".TXT";
                String filePath = "aers_ascii_" + year + "q" + month;
                String databaseName = name + yearx + "Q" + month;

                String filePathAll = "D:/Mysql/mysql-8.0.26-winx64/FAERSsrc/" + year + "/" + filePath + "/ascii/" + filename;
                try {
                    fearsServiceImpl.getDrug(filePathAll, databaseName, response);
                } catch (Exception e) {
                    log.error("写入drug失败", e);
                }
            }
        }
        try {
            response.getWriter().close();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }

    }

    @GetMapping("/drug/write2")
    public void drugWrite2(HttpServletResponse response, String name) {
//            fearsServiceImpl.getDrug("", databaseName,response);

        for (int year = 2012; year <= 2023; year++) {
            for (int month = 1; month <= 4; month++) {
                String yearx = String.valueOf(year).substring(2, 4);


                String filename = name + yearx + "q" + month + ".txt";
                String filePath = "faers_ascii_" + year + "q" + month;
                String databaseName = name + yearx + "Q" + month;

                String filePathAll = "D:/Mysql/mysql-8.0.26-winx64/FAERSsrc/" + year + "/" + filePath + "/ascii/" + filename;
                try {
                    fearsServiceImpl.getDrug(filePathAll, databaseName, response);
                } catch (Exception e) {
                    log.error("写入drug失败", e);
                }
            }
        }
        try {
            response.getWriter().close();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }


    }


    @GetMapping("/drug/write3")
    public void drugWrite3(HttpServletResponse response, String year, String month) {
//            fearsServiceImpl.getDrug("", databaseName,response);


//        String year = String.valueOf(yearx);
        String filename1 = "DEMO" + year.substring(2, 4) + "Q" + month + ".txt";
        String filePath = "faers_ascii_" + year + "q" + month;
        String databaseName1 = "DEMO" + year.substring(2, 4) + "Q" + month;

        String filePathAll1 = "D:/Mysql/mysql-8.0.26-winx64/FAERSsrc/" + year + "/" + filePath + "/ascii/" + filename1;
        try {
            fearsServiceImpl.getDrug(filePathAll1, databaseName1, response);
        } catch (Exception e) {
            log.error("写入drug失败", e);
        }

        String filename2 = "DRUG" + year.substring(2, 4) + "Q" + month + ".txt";
        String databaseName2 = "DRUG" + year.substring(2, 4) + "Q" + month;

        String filePathAll2 = "D:/Mysql/mysql-8.0.26-winx64/FAERSsrc/" + year + "/" + filePath + "/ascii/" + filename2;
        try {
            fearsServiceImpl.getDrug(filePathAll2, databaseName2, response);
        } catch (Exception e) {
            log.error("写入drug失败", e);
        }


        String filename3 = "INDI" + year.substring(2, 4) + "Q" + month + ".txt";
        String databaseName3 = "INDI" + year.substring(2, 4) + "Q" + month;

        String filePathAll3 = "D:/Mysql/mysql-8.0.26-winx64/FAERSsrc/" + year + "/" + filePath + "/ascii/" + filename3;
        try {
            fearsServiceImpl.getDrug(filePathAll3, databaseName3, response);
        } catch (Exception e) {
            log.error("写入drug失败", e);
        }

        String filename4 = "OUTC" + year.substring(2, 4) + "Q" + month + ".txt";
        String databaseName4 = "OUTC" + year.substring(2, 4) + "Q" + month;

        String filePathAll4 = "D:/Mysql/mysql-8.0.26-winx64/FAERSsrc/" + year + "/" + filePath + "/ascii/" + filename4;
        try {
            fearsServiceImpl.getDrug(filePathAll4, databaseName4, response);
        } catch (Exception e) {
            log.error("写入drug失败", e);
        }


        String filename5 = "REAC" + year.substring(2, 4) + "Q" + month + ".txt";
        String databaseName5 = "REAC" + year.substring(2, 4) + "Q" + month;

        String filePathAll5 = "D:/Mysql/mysql-8.0.26-winx64/FAERSsrc/" + year + "/" + filePath + "/ascii/" + filename5;
        try {
            fearsServiceImpl.getDrug(filePathAll5, databaseName5, response);
        } catch (Exception e) {
            log.error("写入drug失败", e);
        }


        String filename6 = "THER" + year.substring(2, 4) + "Q" + month + ".txt";
        String databaseName6 = "THER" + year.substring(2, 4) + "Q" + month;

        String filePathAll6 = "D:/Mysql/mysql-8.0.26-winx64/FAERSsrc/" + year + "/" + filePath + "/ascii/" + filename6;
        try {
            fearsServiceImpl.getDrug(filePathAll6, databaseName6, response);
        } catch (Exception e) {
            log.error("写入drug失败", e);
        }
    }


    @GetMapping("/drug/filter")
    public void drugWrite4() {
//        for (int year = 2004; year <= 2025; year++) {
        int year = 2025;
            for (int month = 1; month <= 4; month++) {
                String yearx = String.valueOf(year).substring(2, 4);
                String table = "DEMO" + yearx + "Q" + month;
//                if ((!(month == 4 && year == 2012)) && (year <= 2012)) {
//
//                    long instructionsCleaning = mongoUtil.mongo.count(new Query(), table);
//                    long page = instructionsCleaning / 1000 + 1;
//                    for (int i = 0; i < page; i++) {
//                        List<JSONObject> instructionsCleaning1 = mongoUtil.mongo.find(
//                                new Query()
//                                        .with(Sort.by(Sort.Direction.ASC, "ISR")) // 先按 ISR 倒序
//                                        .skip(i * 1000)
//                                        .limit(1000),
//                                JSONObject.class,
//                                table
//                        );   // 使用 stream 进行分组和筛选
//                        int finalMonth = month;
//                        instructionsCleaning1.forEach(json -> {
//                            Long caseValue = json.getLong("CASE");
//                            Long isrValue = json.getLong("ISR");
//
//
//                            json.put("caseid", caseValue);
//                            json.put("primaryid", isrValue);
//                            json.put("_id", caseValue);
//                            json.put("table",yearx + "Q" + finalMonth);
//
//
//                            json.remove("CASE");
//                            json.remove("ISR");
//                        });
//
//
//                        Map<String, JSONObject> uniqueByCaseWithMaxISR = instructionsCleaning1.stream()
//                                .filter(json -> json.containsKey("caseid") && json.getString("caseid") != null)
//                                .collect(Collectors.groupingBy(
//                                        json -> json.getString("caseid"),
//                                        Collectors.collectingAndThen(
//                                                Collectors.maxBy(Comparator.comparingLong(json -> json.getLongValue("primaryid"))),
//                                                optional -> optional.orElse(null)
//                                        )
//                                ));
//                        // 转换为最终结果列表
//                        List<JSONObject> result = new ArrayList<>(uniqueByCaseWithMaxISR.values());
//                        ArrayList<String> strings = new ArrayList<>();
//                        for (JSONObject jsonObject : result) {
//                            strings.add(jsonObject.getString("_id"));
//                        }
//
//                        List<Object> ids = result.stream().map(obj -> obj.get("_id")).collect(Collectors.toList());
//                        Query deleteQuery = new Query(Criteria.where("_id").in(ids));
//                        mongoUtil.mongo.remove(deleteQuery, "DEMOOnly" + year);
//                        mongoUtil.mongo.remove(deleteQuery, "DEMOOnly" + (year - 1));
//                        mongoUtil.mongo.remove(deleteQuery, "DEMOOnly" + (year - 2));
//
//
//                        BulkOperations bulkOps = mongoUtil.mongo.bulkOps(BulkOperations.BulkMode.UNORDERED, "DEMOOnly" + year);
//                        bulkOps.insert(result);
//                        bulkOps.execute();
//                    }
//
//                } else {

                long instructionsCleaning = mongoUtil.mongo.count(new Query(), table);
                long page = instructionsCleaning / 300 + 1;
                for (int i = 0; i < page; i++) {
                    Aggregation aggregation = Aggregation.newAggregation(
                            Aggregation.sort(Sort.Direction.ASC, "primaryid"),
                            Aggregation.skip((long) i * 300),
                            Aggregation.limit(300)
                    ).withOptions(AggregationOptions.builder().allowDiskUse(true).build());

                    List<JSONObject> instructionsCleaning1 = mongoUtil.mongo.aggregate(
                            aggregation,
                            table,
                            JSONObject.class
                    ).getMappedResults();

                    int finalMonth1 = month;
                    instructionsCleaning1.forEach(json -> {
                        Long caseValue = json.getLong("caseid");


                        if (caseValue == null) {
                            return;
                        }
                        json.put("table", yearx + "Q" + finalMonth1);

                        json.put("_id", caseValue);

                    });


                    Map<String, JSONObject> uniqueByCaseWithMaxISR = instructionsCleaning1.stream()
                            .filter(json -> json.containsKey("caseid") && json.getString("caseid") != null)
                            .collect(Collectors.groupingBy(
                                    json -> json.getString("caseid"),
                                    Collectors.collectingAndThen(
                                            Collectors.maxBy(Comparator.comparingLong(json -> json.getLongValue("primaryid"))),
                                            optional -> optional.orElse(null)
                                    )
                            ));
                    // 转换为最终结果列表
                    List<JSONObject> result = new ArrayList<>(uniqueByCaseWithMaxISR.values());
                    ArrayList<String> strings = new ArrayList<>();
                    for (JSONObject jsonObject : result) {
                        strings.add(jsonObject.getString("caseid"));
                    }


                    List<Object> ids = result.stream().map(obj -> obj.get("_id")).collect(Collectors.toList());
                    Query deleteQuery = new Query(Criteria.where("_id").in(ids));
                    mongoUtil.mongo.remove(deleteQuery, "DEMOOnly" + year);
                    mongoUtil.mongo.remove(deleteQuery, "DEMOOnly" + (year - 1));
                    mongoUtil.mongo.remove(deleteQuery, "DEMOOnly" + (year - 2));
                    mongoUtil.mongo.remove(deleteQuery, "DEMOOnly" + (year - 3));
                    mongoUtil.mongo.remove(deleteQuery, "DEMOOnly" + (year - 4));
                    mongoUtil.mongo.remove(deleteQuery, "DEMOOnly" + (year - 5));
                    mongoUtil.mongo.remove(deleteQuery, "DEMOOnly" + (year - 6));
                    mongoUtil.mongo.remove(deleteQuery, "DEMOOnly" + (year - 7));


                    BulkOperations bulkOps = mongoUtil.mongo.bulkOps(BulkOperations.BulkMode.UNORDERED, "DEMOOnly" + year);
                    bulkOps.insert(result);
                    bulkOps.execute();

                }
            }
            //  }


//        }


    }


    @GetMapping("/drug/writeEs")
    public void drugWriteEs(String year) {

        //开始查询数据并进行写入
        IndexOperations indexOperations = elasticsearchRestTemplate.indexOps(AdverseIndex.class);
        // 创建索引
        boolean indexResult = indexOperations.create();
        // 定义mapping关系
        boolean mappingResult = indexOperations.putMapping(indexOperations.createMapping(AdverseIndex.class));

        IndexOperations indexOperations2 = elasticsearchRestTemplate.indexOps(AdverseForCaseIndex.class);
        boolean indexResult2 = indexOperations2.create();
        boolean mappingResult2 = indexOperations2.putMapping(indexOperations2.createMapping(AdverseForCaseIndex.class));


    }

    @GetMapping("/drug/writeEs-noCreat")
    public void drugWriteEsNoCreat() {

        // 将每个年份拆分为独立的列表，每个列表只包含一个年份
         List<String> allYears = Arrays.asList(
        //         "2004", "2005", "2006", "2007",
        //         "2010", "2011", "2012",
        //         "2013"
                "2014", "2015",
               "2016", "2017", "2018",
                "2008", "2009"
        //         "2022", "2024", "2021",
        //         "2025", "2020",
        //         "2023", "2019"
        );

        // 为每个年份单独调用一次 writeEs 方法
        for (String year : allYears) {
            ArrayList<String> singleYearList = new ArrayList<>();
            singleYearList.add(year);
            fearsServiceImpl.writeEs(singleYearList);
        }




    }

    @GetMapping("/drug/search")
    public void drugWritemogo(String search) {
        fearsChoose.getDrug(search);
    }

    @GetMapping("/drug/search1")
    public void drugWritemogo1(String search) {


        fearsChoose.getDemo(search);


    }


    @GetMapping("/drug/pt")
    public void getPt(String search) {


        fearsChoose.getPt(search);


    }


}
