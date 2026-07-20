package com.sentum.drugsafe.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateUtil;
import cn.hutool.http.HttpUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.itextpdf.text.Font;
import com.itextpdf.text.Image;
import com.itextpdf.text.Rectangle;
import com.itextpdf.text.*;
import com.itextpdf.text.pdf.*;
import com.lowagie.text.Cell;
import com.lowagie.text.Table;
import com.lowagie.text.rtf.RtfWriter2;
import com.sentum.drugsafe.enums.TableEnum;
import com.sentum.drugsafe.feign.FineScreenFeign;
import com.sentum.drugsafe.feign.GetPicoFeign;
import com.sentum.drugsafe.feign.ParingPhraseFeign;
import com.sentum.drugsafe.pojo.*;
import com.sentum.drugsafe.service.AlertService;
import com.sentum.drugsafe.trans.VolcengineTransUtils;
import com.sentum.drugsafe.utils.GetMaxSimilarUtil;
import io.quickchart.QuickChart;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.io.IOUtils;
import org.apache.commons.lang3.ObjectUtils;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.index.query.InnerHitBuilder;
import org.elasticsearch.index.query.PrefixQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.elasticsearch.search.collapse.CollapseBuilder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.CriteriaDefinition;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import javax.servlet.ServletOutputStream;
import javax.servlet.http.HttpServletResponse;
import java.awt.*;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URLEncoder;
import java.text.DateFormat;
import java.text.DecimalFormat;
import java.text.SimpleDateFormat;
import java.util.List;
import java.util.*;
import java.util.concurrent.*;

@Slf4j
@Service
public class AlertServiceImpl implements AlertService {
    @Autowired
    private GetPicoFeign getPicoFeign;
    @Autowired
    private ParingPhraseFeign paringPhraseFeign;
    @Autowired
    private FineScreenFeign fineScreenFeign;
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private VolcengineTransUtils volcengineTransUtils;

    public String translate(String word) {
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("word", word);
        return fineScreenFeign.deepl(jsonObject);
    }
    @Override
    public JSONObject analyse(String condition, Long userId) {
        condition = condition.toLowerCase();
        JSONObject result = new JSONObject();
        //干预措施
        String i = "";
        //研究对象
        String o = "";
        // 1、对输入条件进行直接判断
        List<String> wordList = new ArrayList<>();
        if (condition.contains("&&")) {
            String[] split = condition.split("&&");
            wordList.addAll(Arrays.asList(split));
        } else {
            try {
                String feignPico = getPicoFeign.getPico(condition);
                JSONObject pico = JSONObject.parseObject(feignPico);
                String resultPico = pico.getString("result");
                if ("50200".equals(resultPico)) {
                    JSONObject picoJSONObject = pico.getJSONObject("pico");
                    JSONArray arrI = picoJSONObject.getJSONArray("I");
                    if (CollUtil.isNotEmpty(arrI)) {
                        //i = arrI.getString(0);
                        wordList.add(arrI.getString(0));
                    }
                    JSONArray arrO = picoJSONObject.getJSONArray("O");
                    if (CollUtil.isNotEmpty(arrO)) {
                        //o = arrO.getString(0);
                        wordList.add(arrO.getString(0));
                    }
                    if (StringUtils.isEmpty(o)) {
                        JSONArray arrP = picoJSONObject.getJSONArray("P");
                        if (CollUtil.isNotEmpty(arrP)) {
                            //o = arrP.getString(0);
                            wordList.add(arrP.getString(0));
                        }
                    }
                }
                log.info("药物警戒getPico接口返回结果为{}", feignPico);
            } catch (Exception e) {
                log.error("调用getPicoFeign服务异常，启动后备分词逻辑，[{}]", e.getCause().getMessage());
                //调用分词器进行操作
                if (StringUtils.isNotEmpty(condition)) {
                    wordList = paringPhraseFeign.parsingPhrase(condition);
                } else {
                    wordList = fineScreenFeign.jieBaParticiple(condition);
                }
                if (CollUtil.isEmpty(wordList)){
                    wordList.add(condition);
                }
                log.info("药物警戒使用分词器分词结果为{}", wordList.toString());
            }
        }
        //开始对分词结果进行判断
        List<String> arrI = new ArrayList<>();
        List<String> arrO = new ArrayList<>();
        Map<String, String> transResult = new HashMap<>();
        if (GetMaxSimilarUtil.judgeChinese(condition)) {
            transResult = volcengineTransUtils.getTransResult(wordList);
        }
        if (condition.contains("&&")){
            String[] split = condition.split("&&");
            try {
                arrI.add(split[1]);
            }catch (Exception e){
                e.printStackTrace();
            }
            String s = split[0];
            if (GetMaxSimilarUtil.judgeChinese(s)){
                s = transResult.get(s).toLowerCase();
            }
            arrO.add(s);
        }else {
            for (String s : wordList) {
                //使用drug_name_words进行药品的判断
                boolean existsDrug = mongoTemplate.exists(new Query(Criteria.where("words").is(s)), DrugNameWords.class, TableEnum.DrugNameWords.getMsg());
                if (!existsDrug) {
                    String trans = transResult.get(s).toLowerCase();
                    Criteria criteria = new Criteria();
                    criteria.orOperator(Criteria.where("drugName").regex("(?i)^" + s + "$"),
                            Criteria.where("drugZh").regex("(?i)^" + s + "$"),
                            Criteria.where("drugEn").regex("(?i)^" + s + "$"),
                            Criteria.where("drugSynonymEn").regex("(?i)^" + s + "$"),
                            Criteria.where("drugSynonymZh").regex("(?i)^" + s + "$"),
                            Criteria.where("communityNameEn").regex("(?i)^" + s + "$"),
                            Criteria.where("communityNameZh").regex("(?i)^" + s + "$")
                    );
                    existsDrug = mongoTemplate.exists(new Query(criteria),"evaluation_drug_info");
                    if (!existsDrug){
                        Criteria criteria1 = new Criteria();
                        criteria1.orOperator(Criteria.where("drugName").regex("(?i)^" + trans + "$"),
                                Criteria.where("drugZh").regex("(?i)^" + trans + "$"),
                                Criteria.where("drugEn").regex("(?i)^" + trans + "$"),
                                Criteria.where("drugSynonymEn").regex("(?i)^" + trans + "$"),
                                Criteria.where("drugSynonymZh").regex("(?i)^" + trans + "$"),
                                Criteria.where("communityNameEn").regex("(?i)^" + trans + "$"),
                                Criteria.where("communityNameZh").regex("(?i)^" + trans + "$"));
                        existsDrug = mongoTemplate.exists(new Query(criteria),"evaluation_drug_info");
                    }

                } else {
                    DrugNameWords words = mongoTemplate.findOne(new Query(Criteria.where("words").is(s)), DrugNameWords.class, TableEnum.DrugNameWords.getMsg());
                    if (words != null) {
                        transResult.put(s, words.getStandardName());
                    }
                }

                if (existsDrug) {
                    //使用DrugNameWords再次判定一次
                    arrI.add(s);
                }
                //使用不良反应库进行不良反应的判断
                boolean existsPharma;
                if (GetMaxSimilarUtil.judgeChinese(s)) {
                    String trans = transResult.get(s).toLowerCase();
                    existsPharma = mongoTemplate.exists(new Query(Criteria.where("adr").is(trans)), FdaVigiPharma.class, TableEnum.FdaVigiPharma.getMsg());
                } else {
                    existsPharma = mongoTemplate.exists(new Query(Criteria.where("adr").is(s)), FdaVigiPharma.class, TableEnum.FdaVigiPharma.getMsg());
                }
                if (!existsPharma) {
                    //在adrs表中进行检索
                    if (GetMaxSimilarUtil.judgeChinese(s)) {
                        existsPharma = mongoTemplate.exists(new Query(Criteria.where("chinese").is(s)), Adrs.class, TableEnum.ADRS.getMsg());
                    } else {
                        existsPharma = mongoTemplate.exists(new Query(Criteria.where("description").is(s)), Adrs.class, TableEnum.ADRS.getMsg());
                    }
                }
                if (existsPharma) {
                    arrO.add(s);
                }
            }
        }



        if (CollUtil.isNotEmpty(arrI)) {
            i = arrI.get(0);
        }
        if (CollUtil.isNotEmpty(arrO)) {
            o = arrO.get(0);
        }


        // 2、开始对条件进行判断
        Condition data = new Condition();
        String id = UUID.randomUUID().toString();
        data.setId(id);
        data.setCondition(condition);
        data.setTimeStamp(System.currentTimeMillis());
        int type;
        if (StringUtils.isNotEmpty(i) && StringUtils.isNotEmpty(o)) {
            //i+O
            type = 1;
            DrugNameWords drugNameWords = mongoTemplate.findOne(new Query(Criteria.where("words").is(i)), DrugNameWords.class, TableEnum.DrugNameWords.getMsg());
            data.setOriginalI(i);
            data.setOriginalO(o);
            if (GetMaxSimilarUtil.judgeChinese(i)) {
                data.setI(transResult.get(i).toLowerCase());
            } else {
                data.setI(i);
            }
            if (GetMaxSimilarUtil.judgeChinese(o)) {
                data.setO(transResult.get(o).toLowerCase());
            } else {
                data.setO(o);
            }
            if (drugNameWords != null) {
                data.setI(drugNameWords.getStandardName());
            }
            if (GetMaxSimilarUtil.judgeChinese(o)) {
                data.setO(transResult.get(o));
            }
        } else if (StringUtils.isNotEmpty(i)) {
            //i
            type = 2;
            data.setOriginalI(i);
            if (GetMaxSimilarUtil.judgeChinese(i)) {
                data.setI(transResult.get(i).toLowerCase());
            } else {
                data.setI(i);
            }
            DrugNameWords drugNameWords = mongoTemplate.findOne(new Query(Criteria.where("words").is(i)), DrugNameWords.class, TableEnum.DrugNameWords.getMsg());
            if (drugNameWords != null) {
                if (StringUtils.isNotBlank(drugNameWords.getStandardName())) {
                    data.setI(drugNameWords.getStandardName());
                }
            }
        } else {
            //o 或者 同时不存在，直接讲输入条件作为不良反应
            type = 3;
            if (StringUtils.isNotEmpty(o)) {
                if (GetMaxSimilarUtil.judgeChinese(o)) {
                    data.setO(transResult.get(o).toLowerCase());
                } else {
                    data.setO(o);
                }
                data.setOriginalO(o);
            } else {
                data.setO(condition);
                data.setOriginalO(condition);
            }
        }
        data.setType(type);
        data.setUserId(userId);
        data.setIsApp("1");
        mongoTemplate.remove(new Query(Criteria.where("condition").is(condition).and("userId").is(userId)), Condition.class);
        mongoTemplate.save(data);
        result.put("id", id);
        result.put("type", type);
        return result;
    }

    @Override
    public JSONObject findIForOnlyO(String id, String searchData, Integer pageSize, Integer pageNum, Integer sort) {
        JSONObject result = new JSONObject();
        result.put("pageNum", pageNum);
        result.put("pageSize", pageSize);
        JSONArray data = new JSONArray();
        int pages = 0;
        int total = 0;
        long searchNum = 0;
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition != null) {
            if (condition.getType() == 3) {
                String o = condition.getO();
                Query query = new Query(Criteria.where("adr").is(o).and("database").is("fda"));
                FdaVigiPharma fdaVigiPharma = mongoTemplate.findOne(query, FdaVigiPharma.class, TableEnum.FdaVigiPharma.getMsg());
                if (fdaVigiPharma != null) {
                    List<String> drugList = fdaVigiPharma.getDrugList();
                    total = drugList.size();
                    //判断是否需要正则匹配
                    List<String> lastList = new ArrayList<>();
                    if (StringUtils.isNotEmpty(searchData)) {
                        for (String s : drugList) {
                            if (s.toLowerCase().contains(searchData)) {
                                lastList.add(s);
                            }
                        }
                    } else {
                        lastList.addAll(drugList);
                    }
                    //开始进行分页
                    if (CollUtil.isNotEmpty(lastList)) {
                        Query query1 = new Query(Criteria.where("drugName").in(lastList).and("description").is(o).and("database").is("fda"));
                        searchNum = mongoTemplate.count(query1, Adrs.class);
                        //排序
                        if (sort == 1) {
                            query1.with(PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.DESC, "indicator")));
                        } else if (sort == 2) {
                            query1.with(PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.ASC, "indicator")));
                        } else {
                            query1.with(PageRequest.of(pageNum - 1, pageSize));
                        }
                        List<Adrs> adrsList = mongoTemplate.find(query1, Adrs.class);
                        Map<String, Integer> map = new HashMap<>();
                        for (Adrs adrs : adrsList) {
                            JSONObject inner = new JSONObject();
                            String drugName = adrs.getDrugName();
                            if (!map.containsKey(drugName)) {
                                map.put(drugName, 1);
                            } else {
                                searchNum--;
                                continue;
                            }
                            String indicator = adrs.getIndicator();
                            inner.put("name", drugName);
                            inner.put("signal", indicator);
                            data.add(inner);
                        }
                        if (searchNum > total){
                            searchNum = total;
                        }
                        int i = (int) (searchNum % pageSize);
                        if (i > 0) {
                            pages = (int) (searchNum / pageSize);
                        } else {
                            pages = (int) (searchNum / pageSize + 1);
                        }

                        /*
                        List<String> list = lastList.subList((pageNum - 1) * pageSize, Math.min(pageNum * pageSize, total));
                        //分页完成后进行信号的匹配
                        for (String s : list) {
                            JSONObject inner = new JSONObject();
                            inner.put("name", s);
                            inner.put("signal", "-");
                            Adrs adrs = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(s).and("description").is(o)), Adrs.class);
                            if (adrs != null){
                                String indicator = adrs.getIndicator();
                                inner.put("signal", indicator);
                            }
                            data.add(inner);
                        }

                         */
                    }
                }
            }
        }
        result.put("explain", "基于FAERS数据库，统计出能够导致" + (condition != null ? condition.getOriginalO() : "") + "的所有药物（共" + total + "个）。");
        result.put("list", data);
        result.put("pages", pages);
        result.put("total", searchNum);
        return result;
    }

    @Override
    public JSONObject findIForOnlyOApp(String id, String searchData, Integer pageSize, Integer pageNum, Integer choice) {
        JSONObject result = new JSONObject();
        result.put("pageNum", pageNum);
        result.put("pageSize", pageSize);
        JSONArray data = new JSONArray();
        int pages = 0;
        int total = 0;
        long searchNum = 0;
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition != null) {
            if (condition.getType() == 3) {
                String o = condition.getO();
                Query query = new Query(Criteria.where("adr").is(o).and("database").is("fda"));
                FdaVigiPharma fdaVigiPharma = mongoTemplate.findOne(query, FdaVigiPharma.class, TableEnum.FdaVigiPharma.getMsg());
                if (fdaVigiPharma != null) {
                    List<String> drugList = fdaVigiPharma.getDrugList();
                    total = drugList.size();
                    //判断是否需要正则匹配
                    List<String> lastList = new ArrayList<>();
                    if (StringUtils.isNotEmpty(searchData)) {
                        for (String s : drugList) {
                            if (s.toLowerCase().contains(searchData)) {
                                lastList.add(s);
                            }
                        }
                    } else {
                        lastList.addAll(drugList);
                    }
                    //开始进行分页
                    if (CollUtil.isNotEmpty(lastList)) {
                        List<Criteria> criteriaList = new ArrayList<>();
                        criteriaList.add(Criteria.where("drugName").in(lastList));
                        criteriaList.add(Criteria.where("description").is(o));
                        criteriaList.add(Criteria.where("database").is("fda"));
                        //choice用户选择典型或者非典型信号
                        if (choice != null) {
                            if (choice == 1) {
                                criteriaList.add(Criteria.where("indicator").is("+"));
                            }else {
                                criteriaList.add(Criteria.where("indicator").is("-"));
                            }
                        }
                        Criteria criteria = new Criteria();
                        criteria.andOperator(criteriaList.toArray(new Criteria[0]));
                        Query query1 = new Query(criteria);
                        searchNum = mongoTemplate.count(query1, Adrs.class);
                        query1.with(PageRequest.of(pageNum - 1, pageSize));
                        List<Adrs> adrsList = mongoTemplate.find(query1, Adrs.class);
                        Map<String, Integer> map = new HashMap<>();
                        for (Adrs adrs : adrsList) {
                            JSONObject inner = new JSONObject();
                            String drugName = adrs.getDrugName();
                            if (!map.containsKey(drugName)) {
                                map.put(drugName, 1);
                            } else {
                                searchNum--;
                                continue;
                            }
                            String indicator = adrs.getIndicator();
                            inner.put("name", drugName);
                            inner.put("signal", indicator);
                            data.add(inner);
                        }
                        if (searchNum > total){
                            searchNum = total;
                        }
                        int i = (int) (searchNum % pageSize);
                        if (i > 0) {
                            pages = (int) (searchNum / pageSize);
                        } else {
                            pages = (int) (searchNum / pageSize + 1);
                        }
                    }
                }
            }
        }
        result.put("explain", "基于FAERS数据库，统计出能够导致" + (condition != null ? condition.getOriginalO() : "") + "的所有药物（共" + total + "个）。");
        result.put("list", data);
        result.put("pages", pages);
        result.put("total", searchNum);
        return result;
    }

    @Override
    public JSONObject analysisOverview(String id, Integer type) {
        JSONObject result = new JSONObject();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        List<String> list = new ArrayList<>();
        if (condition != null) {
            if (condition.getType() == 2) {
                //i fda与vigi同时存在
                result.put("status", 0);
                String originalI = condition.getOriginalI();
                String i = condition.getI();
                list.add("基于您的检索词（" + originalI + "）：");
                DrugAlert drugAlert;
                drugAlert = mongoTemplate.findOne(new Query(Criteria.where("drugname").is(i)), DrugAlert.class, TableEnum.FdaDrugIAlert.getMsg());
                if (drugAlert == null) {
                    drugAlert = mongoTemplate.findOne(new Query(Criteria.where("prod_ai").is(i)), DrugAlert.class, TableEnum.FdaDrugIAlertProdAi.getMsg());
                }
                //统计单独输入药品的时候vigi库不良反应总数
                DrugAlert vigiDrugAlert = mongoTemplate.findOne(new Query(Criteria.where("drug_name").is(i)), DrugAlert.class, TableEnum.VigiDrugIAlert.getMsg());
                if (drugAlert != null || vigiDrugAlert != null) {
                    String fdaValue = "";
                    if (drugAlert != null) {
                        //总数
                        Integer totalNum = drugAlert.getTotalNum();
                        //single_num+dul_drug
                        Integer singleNum = drugAlert.getSingleNum();
                        Integer dulDrug = drugAlert.getDulDrug();
                        fdaValue = "FAERS数据库排除重复报告后，共得到相关报告" + totalNum + "例，从中筛选出以“" + originalI + "”为怀疑药物的报告，共" + (singleNum + dulDrug) + "例。";
                    }
                    String vigiValue = "";
//                    if (vigiDrugAlert != null) {
//                        Integer singleNum = vigiDrugAlert.getSingleNum();
//                        vigiValue = "VigiAccess数据库共获得“" + originalI + "”相关不良反应报告" + singleNum + "例。";
//                    }
                    list.add(fdaValue + vigiValue);
                }
                //判断fda与vigi共同含有的信号名称
                if (drugAlert != null) {
                    Map<String, List<List<String>>> signalDict = drugAlert.getSignalDict();
                    if (CollUtil.isNotEmpty(signalDict)) {
                        List<String> nameList = new ArrayList<>();
                        Set<Map.Entry<String, List<List<String>>>> entries1 = signalDict.entrySet();
                        for (Map.Entry<String, List<List<String>>> stringListEntry : entries1) {
                            List<List<String>> value = stringListEntry.getValue();
                            for (List<String> strings : value) {
                                nameList.add(strings.get(0));
                                if(nameList.size()>2){
                                    break;
                                }
                            }
                            if(nameList.size()>2){
                                break;
                            }
                        }
//                    if (CollUtil.isNotEmpty(signalDict)) {
//                        DrugAlert vigiData = mongoTemplate.findOne(new Query(Criteria.where("drug_name").is(i)), DrugAlert.class, TableEnum.VigiDrugIAlert.getMsg());
//                        if (vigiData != null) {
//                            Map<String, List<List<String>>> vigiDataSignalDict = vigiData.getSignalDict();
//                            if (CollUtil.isNotEmpty(vigiDataSignalDict)) {
//                                //开始取交集
//                                Map<String, String> onlyMap = new HashMap<>();
//                                List<String> nameList = new ArrayList<>();
//                                List<String> fdaList = new ArrayList<>();
//                                Set<Map.Entry<String, List<List<String>>>> entries1 = signalDict.entrySet();
//                                for (Map.Entry<String, List<List<String>>> stringListEntry : entries1) {
//                                    List<List<String>> value = stringListEntry.getValue();
//                                    for (List<String> strings : value) {
//                                        fdaList.add(strings.get(0));
//                                        onlyMap.put(strings.get(0), strings.get(1));
//                                    }
//                                }
//                                Set<Map.Entry<String, List<List<String>>>> entries2 = vigiDataSignalDict.entrySet();
//                                for (Map.Entry<String, List<List<String>>> stringListEntry : entries2) {
//                                    List<List<String>> value = stringListEntry.getValue();
//                                    for (List<String> strings : value) {
//                                        if (fdaList.contains(strings.get(0))) {
//                                            nameList.add(strings.get(0));
//                                        }
//                                    }
//                                }
//
//                                if (CollUtil.isNotEmpty(nameList)) {
//                                    String name;
//                                    if (nameList.size() > 1) {
//                                        name = nameList.get(0) + "（" + onlyMap.get(nameList.get(0)) + "）" + "、" + nameList.get(1) + "（" + onlyMap.get(nameList.get(1)) + "）";
//                                    } else {
//                                        name = nameList.get(0);
//                                    }
//                                    list.add("根据数据统计结果，系统通过AI计算对比，该药品在FAERS数据库与VigiAccess数据库中共有的典型信号包括：" + name + "等。");
//                                } else {
//                                    list.add("根据数据统计结果，系统通过AI计算对比，该药品在FAERS数据库与VigiAccess数据库无共有的典型信号。");
//                                }
//                            }
//                        } else {
//                            list.add("根据数据统计结果，系统通过AI计算对比，该药品在FAERS数据库与VigiAccess数据库无共有的典型信号。");
//                        }
//                    }
                        list.add("根据数据统计结果，系统通过AI计算对比，该药品在FAERS数据库的典型信号包括：" + CollUtil.join(nameList, "、") + "等。");
                    }else {
                        list.add("根据数据统计结果，系统通过AI计算对比，该药品在FAERS数据库没有典型信号。"); }
                } else {
                    list.add("根据数据统计结果，系统通过AI计算对比，该药品在FAERS数据库没有典型信号。");
                }
                //隐藏vigi数据后，显示药品的top5典型信号
                /*LinkedHashMap<String, Double> linkedHashMap = new LinkedHashMap<>();
                if (drugAlert != null) {
                    Map<String, List<List<String>>> signalDict = drugAlert.getSignalDict();
                    Map<String, Double> map = new HashMap<>();
                    if (CollUtil.isNotEmpty(signalDict)) {
                        Set<Map.Entry<String, List<List<String>>>> entries = signalDict.entrySet();
                        for (Map.Entry<String, List<List<String>>> entry : entries) {
                            List<List<String>> value = entry.getValue();
                            for (List<String> strings : value) {
                                String englishName = strings.get(0);
                                String chineseName = strings.get(1);
                                String ic = strings.get(5);
                                try {
                                    double aDouble = Double.parseDouble(ic);
                                    map.put(englishName + "（" + chineseName + "）", aDouble);
                                } catch (NumberFormatException e) {
                                    log.error("数据统计转化double类型异常[{}]", ic);
                                }
                            }
                        }
                        //开始对map进行排序，取前5
                        List<Map.Entry<String, Double>> entryList = new ArrayList<>(map.entrySet());
                        entryList.sort((o1, o2) -> {
                            double value = o2.getValue()-o1.getValue();
                            if (value > 0){
                                return 1;
                            }else if (value == 0){
                                return 0;
                            }else {
                                return -1;
                            }
                        });
                        for (Map.Entry<String, Double> e : entryList) {
                            linkedHashMap.put(e.getKey(), e.getValue());
                        }
                        if (linkedHashMap.size() > 5){
                            LinkedHashMap<String, Double> newMap = new LinkedHashMap<>();
                            Set<Map.Entry<String, Double>> entries1 = linkedHashMap.entrySet();
                            int range = 0;
                            for (Map.Entry<String, Double> entry : entries1) {
                                newMap.put(entry.getKey(), entry.getValue());
                                range++;
                                if (range >= 5){
                                    break;
                                }
                            }
                            linkedHashMap = newMap;
                        }
                    }
                }
                if (CollUtil.isNotEmpty(linkedHashMap)){
                    StringBuilder builder = new StringBuilder();
                    builder.append("根据数据统计结果，系统通过AI计算对比，该药品在FAERS数据库中TOP5的典型信号包括：");
                    Set<Map.Entry<String, Double>> entries = linkedHashMap.entrySet();
                    for (Map.Entry<String, Double> entry : entries) {
                        String key = entry.getKey();
                        builder.append(key).append("，");
                    }
                    builder.append("。");
                    list.add(builder.toString().replaceAll("，。", "。"));
                }else {
                    list.add("根据数据统计结果，系统通过AI计算对比，该药品在FAERS数据库与VigiAccess数据库无共有的典型信号。");
                }*/
                if (drugAlert != null) {
                    List<List<String>> outCodList = drugAlert.getOutCCodList();
                    if (CollUtil.isNotEmpty(outCodList)) {
                        List<String> strings = outCodList.get(0);
                        list.add("该药品上报的所有报告中，严重不良事件（SAE）中以" + strings.get(1) + "报告数最多（" + strings.get(2) + "例，" + strings.get(3) + "）。");
                    }
                }
            } else {
                if (type == 2) {
                    result.put("status", 1);
                } else {
                    //i+o fda
                    result.put("status", 0);
                    String originalI = condition.getOriginalI();
                    String originalO = condition.getOriginalO();
                    String i = condition.getI();
                    String o = condition.getO();
                    list.add("基于您的检索词（" + originalI + " AND " + originalO + "）：");
                    //fda_drug_alert_3_translate_new + fda_drug_alert_3_prod_ai_translate_new
                    DrugAlert drugAlert = mongoTemplate.findOne(new Query(Criteria.where("drugname").is(i).and("pt").is(o)), DrugAlert.class, TableEnum.FdaDrugAlert.getMsg());
                    if (drugAlert == null) {
                        drugAlert = mongoTemplate.findOne(new Query(Criteria.where("prod_ai").is(i).and("pt").is(o)), DrugAlert.class, TableEnum.FdaDrugAlertProdAi.getMsg());
                    }
                    if (drugAlert != null) {
                        //总数
                        //Integer totalNum = drugAlert.getTotalNum();
                        //single_num+dul_drug
                        Integer singleNum = drugAlert.getSingleNum();
                        Integer dulDrug = drugAlert.getDulDrug();
                        list.add(" FAERS数据库排除重复报告后，筛选出以" + originalI + "为怀疑药物并导致" + originalO + "的报告共" + (singleNum + dulDrug) + "例。");
                        //list.add("FAERS数据库排除重复报告后，共得到相关报告" + totalNum + "例，从中筛选出以“" + originalI + "”为怀疑药物的报告，共" + (singleNum + dulDrug) + "例。");
                    }
                    Adrs adrs = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(i).and("description").is(o)), Adrs.class);
                    if (adrs != null) {
                        String database = adrs.getDatabase();
                        String name;
                        if ("fda".equals(database)) {
                            name = "在FAERS数据库";
                        } else {
                            name = "VigiAccess数据库";
                        }
                        String judge;
                        String indicator = adrs.getIndicator();
                        if ("-".equals(indicator)) {
                            judge = "非";
                        } else {
                            judge = "是";
                        }
                        list.add("根据数据统计结果，系统通过AI计算对比，" + name + "此不良反应" + judge + "该药品的典型不良反应信号。");
                    }
                    if (drugAlert != null) {
                        List<List<String>> outCodList = drugAlert.getOutCCodList();
                        if (CollUtil.isNotEmpty(outCodList)) {
                            List<String> strings = outCodList.get(0);
                            list.add(originalI + "致" + originalO + "的所有报告中，严重不良事件（SAE）中以" + strings.get(1) + "报告数最多（" + strings.get(2) + "例，" + strings.get(3) + "）。");
                        }
                    }
                }
            }
            result.put("searchWors", condition.getCondition());
            //返回文件名称
            String originalI = "";
            if (StringUtils.isNotBlank(condition.getOriginalI())){
                originalI = condition.getOriginalI();
            }
            String originalO = "";
            if (StringUtils.isNotBlank(condition.getOriginalO())){
                originalO = condition.getOriginalO();
            }
            String i = condition.getI();
            if (StringUtils.isNotBlank(condition.getI())){
                i = condition.getI();
            }
            String o = "";
            if (StringUtils.isNotBlank(condition.getO())){
                o = condition.getO();
            }
            String fileName = "【药品安全性分析报告】";
            String shareStr = "";
            if (StringUtils.isNotEmpty(originalI)) {
                if (!originalI.equals(i)) {
                    fileName = fileName + originalI + "_" + i;
                    shareStr = shareStr + originalI + "_" + i;
                } else {
                    fileName = fileName + originalI;
                    shareStr = shareStr + originalI;
                }
            }
            if (StringUtils.isNotEmpty(originalO)) {
                if (!originalO.equals(o)) {
                    fileName = fileName + "、" + originalO + "_" + o;
                    shareStr = shareStr + "、" + originalO + "_" + o;
                } else {
                    fileName = fileName + "、" + originalO;
                    shareStr = shareStr + "、" + originalO;
                }
            }
            SimpleDateFormat format = new SimpleDateFormat("yyyyMMdd");
            fileName = fileName + "-" + format.format(new Date()) + ".doc";
            result.put("fileName", fileName);
            //拼接分享逻辑所需字段
            Map<String, String> shareData = new HashMap<>();
            shareData.put("title", "药品安全性分析报告");
            shareData.put("describe", shareStr);
            shareData.put("comprehensive", "药品安全性分析报告" + "-" + shareStr);
            shareData.put("url", "https://image.evimed.com/user/img/0.jpg");
            result.put("shareData", shareData);
        }
        result.put("list", list);
        return result;
    }

    @Override
    public JSONObject searchAll(String id, Integer type) {
        String dataName;
        if (type == 1) {
            dataName = "FAERS";
        } else {
            dataName = "VigiAccess";
        }
        JSONObject result = new JSONObject();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition != null) {
            DrugAlert drugAlert = null;
            Integer conditionType = condition.getType();
            String originalI = condition.getOriginalI();
            String i = condition.getI();
            if (conditionType == 1) {
                //i+o
                if (type == 1) {
                    String o = condition.getO();
                    drugAlert = mongoTemplate.findOne(new Query(Criteria.where("drugname").is(i).and("pt").is(o)), DrugAlert.class, TableEnum.FdaDrugAlert.getMsg());
                    if (drugAlert == null) {
                        drugAlert = mongoTemplate.findOne(new Query(Criteria.where("prod_ai").is(i).and("pt").is(o)), DrugAlert.class, TableEnum.FdaDrugAlertProdAi.getMsg());
                    }
                }
            } else {
                //i
                if (type == 1) {
                    drugAlert = mongoTemplate.findOne(new Query(Criteria.where("drugname").is(i)), DrugAlert.class, TableEnum.FdaDrugIAlert.getMsg());
                    if (drugAlert == null) {
                        drugAlert = mongoTemplate.findOne(new Query(Criteria.where("prod_ai").is(i)), DrugAlert.class, TableEnum.FdaDrugIAlertProdAi.getMsg());
                    }
                } else {
                    drugAlert = mongoTemplate.findOne(new Query(Criteria.where("drug_name").is(i)), DrugAlert.class, TableEnum.VigiDrugIAlert.getMsg());
                }
            }
            if (drugAlert != null) {
                //=========================基本情况模块================================
                result.put("basicInformation", new JSONObject());
                //报告分布
                result.getJSONObject("basicInformation").put("reportDistribution", new JSONObject());
                //逐年上报情况
                JSONArray reportYear = new JSONArray();
                List<List<String>> yearList = drugAlert.getYearList();
                String maxYear = "";
                if (CollUtil.isNotEmpty(yearList)) {
                    int maxNum = Integer.MIN_VALUE;
                    //int maxRange = 0;
                    for (List<String> list : yearList) {
                        String name = list.get(1);
                        String num = list.get(2);
                        try {
                            int parseInt = Integer.parseInt(num);
                            if (parseInt > maxNum) {
                                maxNum = parseInt;
                                maxYear = name;
                            }
                        } catch (NumberFormatException e) {
                            log.error("将字符串类型的数量转化成int类型异常");
                        }
                        String percentage = list.get(3);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        reportYear.add(inner);
                    }
                    //对年份进行排序
                    reportYear.sort((o1, o2) -> {
                        int ror1 = Integer.parseInt(JSONObject.parseObject(JSONObject.toJSONString(o1)).getString("name"));
                        int ror2 = Integer.parseInt(JSONObject.parseObject(JSONObject.toJSONString(o2)).getString("name"));
                        return Integer.compare(ror2, ror1);
                    });
                    if (reportYear.size() > 20) {
                        JSONArray newYear = new JSONArray();
                        for (int i1 = 0; i1 < 20; i1++) {
                            newYear.add(reportYear.getJSONObject(i1));
                        }
                        reportYear = newYear;
                    }
                }
                reportYear.sort((o1, o2) -> {
                    int ror1 = Integer.parseInt(JSONObject.parseObject(JSONObject.toJSONString(o1)).getString("name"));
                    int ror2 = Integer.parseInt(JSONObject.parseObject(JSONObject.toJSONString(o2)).getString("name"));
                    return Integer.compare(ror1, ror2);
                });
                result.getJSONObject("basicInformation").getJSONObject("reportDistribution").put("reportYear", reportYear);
                //地区分布
                JSONArray reportCountry = new JSONArray();
                List<List<String>> reporterCountryList = drugAlert.getReporterCountryList();
                String maxCountry = "";
                if (CollUtil.isNotEmpty(reporterCountryList)) {
                    int maxIntCountry = Integer.MIN_VALUE;
                    maxCountry = reporterCountryList.get(0).get(1);
                    for (List<String> list : reporterCountryList) {
                        String name = list.get(1);
                        String num = list.get(2);
                        try {
                            int anInt = Integer.parseInt(num);
                            if (!"未知".equals(name)) {
                                if (anInt > maxIntCountry) {
                                    maxIntCountry = anInt;
                                    maxCountry = name;
                                }
                            }
                        } catch (NumberFormatException e) {
                            e.printStackTrace();
                        }
                        String percentage = list.get(3);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        reportCountry.add(inner);
                    }
                }
                if (reportCountry.size() > 20) {
                    reportCountry.subList(0, 20);
                }
                result.getJSONObject("basicInformation").getJSONObject("reportDistribution").put("reportCountry", reportCountry);
                if (StringUtils.isNotEmpty(maxYear) || StringUtils.isNotEmpty(maxCountry)) {
                    //逐年上报+地区分布结论
                    StringBuilder yearAndCountry = new StringBuilder();
                    yearAndCountry.append("在").append(dataName).append("数据库上报的不良反应报告中");
                    if (StringUtils.isNotEmpty(maxYear)) {
                        yearAndCountry.append("在").append(maxYear).append("年达到峰值");
                    }
                    if (StringUtils.isNotEmpty(maxCountry)) {
                        yearAndCountry.append("，以").append(maxCountry).append("上报者居多");
                    }
                    yearAndCountry.append("。");
                    result.getJSONObject("basicInformation").getJSONObject("reportDistribution").put("yearAndCountry", yearAndCountry.toString());
                }

                //职业分布
                JSONArray reportOccupation = new JSONArray();
                List<List<String>> ocpCod = drugAlert.getOccpCod();
                String maxName = "";
                if (CollUtil.isNotEmpty(ocpCod)) {
                    int maxNum = Integer.MIN_VALUE;
                    for (List<String> list : ocpCod) {
                        String name = list.get(1);
                        String num = list.get(2);
                        try {
                            int parseInt = Integer.parseInt(num);
                            if (parseInt > maxNum) {
                                if (!"未知".equals(name)) {
                                    maxName = name;
                                    maxNum = parseInt;
                                }
                            }
                        } catch (NumberFormatException e) {
                            log.error("将字符串类型的数量转化成int类型异常");
                        }
                        String percentage = list.get(3);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        reportOccupation.add(inner);
                    }
                }
                result.getJSONObject("basicInformation").getJSONObject("reportDistribution").put("reportOccupation", reportOccupation);
                if (StringUtils.isNotEmpty(maxName)) {
                    //职业分布结论
                    result.getJSONObject("basicInformation").getJSONObject("reportDistribution").put("occupation", "在" + dataName + "数据库上报的不良反应报告中，以" + maxName + "上报居多。");
                }

                //人群分布
                result.getJSONObject("basicInformation").put("populationDistribution", new JSONObject());
                //性别分布
                JSONArray reportSex = new JSONArray();
                List<List<String>> sexMf = drugAlert.getSexMf();
                String maxType = "";
                if (CollUtil.isNotEmpty(sexMf)) {
                    try {
                        String manCount = sexMf.get(0).get(2);
                        String womanCount = sexMf.get(1).get(2);
                        int anInt1 = Integer.parseInt(manCount);
                        int anInt2 = Integer.parseInt(womanCount);
                        if (anInt1 == anInt2) {
                            maxType = "男性与女性占比基本持平";
                        } else if (anInt1 > anInt2) {
                            maxType = "男性占比高于女性";
                        } else {
                            maxType = "女性占比高于男性";
                        }
                    } catch (NumberFormatException e) {
                        log.error("判断男女占比异常");
                    }
                    for (List<String> list : sexMf) {
                        String name = list.get(1);
                        String num = list.get(2);
                        String percentage = list.get(3);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        reportSex.add(inner);
                    }
                }
                result.getJSONObject("basicInformation").getJSONObject("populationDistribution").put("reportSex", reportSex);
                //年龄分布
                JSONArray reportAge = new JSONArray();
                List<List<String>> ageList = drugAlert.getAgeList();
                String maxAge = "";
                if (CollUtil.isNotEmpty(ageList)) {
                    int maxNum = Integer.MIN_VALUE;
                    for (List<String> list : ageList) {
                        String name = list.get(1);
                        String num = list.get(2);
                        try {
                            int parseInt = Integer.parseInt(num);
                            if (parseInt > maxNum) {
                                if (!"未知".equals(name)) {
                                    maxNum = parseInt;
                                    maxAge = name;
                                }
                            }
                        } catch (NumberFormatException e) {
                            log.error("将字符串类型的数量转化成int类型异常");
                        }
                        String percentage = list.get(3);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        reportAge.add(inner);
                    }
                }
                result.getJSONObject("basicInformation").getJSONObject("populationDistribution").put("reportAge", reportAge);
                if (StringUtils.isNotEmpty(maxType) || StringUtils.isNotEmpty(maxAge)) {
                    //性别分布+年龄分布结论
                    StringBuilder sexAndAge = new StringBuilder();
                    sexAndAge.append("在").append(dataName).append("数据库上报的不良反应报告中");
                    if (StringUtils.isNotEmpty(maxType)) {
                        sexAndAge.append("，").append(maxType);
                    }
                    if (StringUtils.isNotEmpty(maxAge)) {
                        sexAndAge.append("，年龄大多分布在").append(maxAge);
                    }
                    sexAndAge.append("。");
                    result.getJSONObject("basicInformation").getJSONObject("populationDistribution").put("sexAndAge", sexAndAge.toString());
                }

                //体重分布  区间显示
                JSONArray reportWeight = new JSONArray();
                List<List<String>> wtList = drugAlert.getWtList();
                String maxWeight = "";
                long sum = 0L;
                Map<String, Long> weightMap = new LinkedHashMap<>();
                if (CollUtil.isNotEmpty(wtList)) {
                    weightMap.put("<50kg", 0L);
                    weightMap.put("50~100kg", 0L);
                    weightMap.put(">100kg", 0L);
                    weightMap.put("未知", 0L);
                    for (List<String> list : wtList) {
                        String name = list.get(1);
                        String num = list.get(2);
                        //String percentage = list.get(3);
                        sum = sum + Long.parseLong(num);
                        if ("unknown".equals(name)) {
                            weightMap.put("未知", weightMap.get("未知")+Long.parseLong(num));
                        }else {
                            int anInt = Integer.parseInt(name);
                            if (anInt < 50){
                                weightMap.put("<50kg", weightMap.get("<50kg")+Long.parseLong(num));
                            }else if (anInt > 100){
                                weightMap.put("50~100kg", weightMap.get("50~100kg")+Long.parseLong(num));
                            }else {
                                weightMap.put(">100kg", weightMap.get(">100kg")+Long.parseLong(num));
                            }
                        }
                    }
                }
                long maxLong = Long.MIN_VALUE;
                Set<Map.Entry<String, Long>> entries1 = weightMap.entrySet();
                for (Map.Entry<String, Long> stringLongEntry : entries1) {
                    String key = stringLongEntry.getKey();
                    Long value = stringLongEntry.getValue();
                    if (!"未知".equals(key)){
                        if (maxLong < value){
                            maxLong = value;
                            maxWeight = key;
                        }
                    }
                    JSONObject inner = new JSONObject();
                    inner.put("name", key);
                    inner.put("num", value);
                    String divide;
                    if (sum == 0){
                        divide = "0";
                    }else {
                        divide = BigDecimal.valueOf(value).multiply(BigDecimal.valueOf(100)).divide(BigDecimal.valueOf(sum), 2, RoundingMode.HALF_UP).doubleValue() + "%";
                    }
                    inner.put("percentage", divide);
                    reportWeight.add(inner);
                }
                result.getJSONObject("basicInformation").getJSONObject("populationDistribution").put("reportWeight", reportWeight);
                if (StringUtils.isNotEmpty(maxWeight) && !"unknown".equals(maxWeight)) {
                    //体重分布结论
                    result.getJSONObject("basicInformation").getJSONObject("populationDistribution").put("weight", "在" + dataName + "数据库报的不良反应报告中，占比较高的体重分布在" + maxWeight + "。");
                }else {
                    result.getJSONObject("basicInformation").getJSONObject("populationDistribution").put("weight", "");
                }
                //加入不良反应报告的数量，用于药物警戒下载
                int allNum = 0;
                Integer singleNum = drugAlert.getSingleNum();
                if (singleNum != null) {
                    allNum += singleNum;
                }
                Integer dulDrug = drugAlert.getDulDrug();
                if (dulDrug != null) {
                    allNum += dulDrug;
                }
                result.getJSONObject("basicInformation").put("allNum", allNum);

                //========================用药情况分析================================
                result.put("drugAnalysis", new JSONObject());
                // 1、用法用量分析
                result.getJSONObject("drugAnalysis").put("usageAndDosage", new JSONObject());
                // 1-1 给药方案 drug_num_list
                JSONArray drugList = new JSONArray();
                String maxDrug = "";
                List<List<String>> drugNumList = drugAlert.getDrugNumList();
                if (CollUtil.isNotEmpty(drugNumList)) {
                    int maxNum = Integer.MIN_VALUE;
                    for (List<String> list : drugNumList) {
                        String name = list.get(1);
                        String num = list.get(2);
                        try {
                            int parseInt = Integer.parseInt(num);
                            if (parseInt > maxNum) {
                                maxNum = parseInt;
                                maxDrug = "大部分为" + name;
                            }
                        } catch (NumberFormatException e) {
                            log.error("将字符串类型的数量转化成int类型异常");
                        }
                        String percentage = list.get(3);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        drugList.add(inner);
                    }
                }
                result.getJSONObject("drugAnalysis").getJSONObject("usageAndDosage").put("drugNumList", drugList);
                // 1-2 剂型分布 dose_form_list
                JSONArray formList = new JSONArray();
                String maxForm = "";
                List<List<String>> doseFormList = drugAlert.getDoseFormList();
                if (CollUtil.isNotEmpty(doseFormList)) {
                    int maxNum = Integer.MIN_VALUE;
                    for (List<String> list : doseFormList) {
                        String name = list.get(1);
                        String num = list.get(2);
                        try {
                            int parseInt = Integer.parseInt(num);
                            if (parseInt > maxNum) {
                                if (!"unknown".equals(name)) {
                                    maxNum = parseInt;
                                    maxForm = "药物剂型占比最高的为" + name;
                                }
                            }
                        } catch (NumberFormatException e) {
                            log.error("将字符串类型的数量转化成int类型异常");
                        }
                        String percentage = list.get(3);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        formList.add(inner);
                    }
                }
                result.getJSONObject("drugAnalysis").getJSONObject("usageAndDosage").put("doseFormList", formList);
                // 1-3 给药用途分布 route_list
                JSONArray route = new JSONArray();
                String maxRoute = "";
                List<List<String>> routeList = drugAlert.getRouteList();
                if (CollUtil.isNotEmpty(routeList)) {
                    if (routeList.size() > 5) {
                        routeList = routeList.subList(0, 5);
                    }
                    int maxNum = Integer.MIN_VALUE;
                    for (List<String> list : routeList) {
                        String englishName = list.get(1);
                        String name = list.get(2);
                        String num = list.get(3);
                        try {
                            int parseInt = Integer.parseInt(num);
                            if (parseInt > maxNum) {
                                if (!"未知".equals(name)) {
                                    maxNum = parseInt;
                                    maxRoute = "大部分通过" + name + "给药";
                                }
                            }
                        } catch (NumberFormatException e) {
                            log.error("将字符串类型的数量转化成int类型异常");
                        }
                        String percentage = list.get(4);
                        JSONObject inner = new JSONObject();
                        inner.put("englishName", englishName);
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        route.add(inner);
                    }
                }
                result.getJSONObject("drugAnalysis").getJSONObject("usageAndDosage").put("route", route);
                // 1-4 计量分布 dose_amt_list
                JSONArray doseAmt = new JSONArray();
                String maxdoseAmt = "";
                int countDoseAmt = 0;
                List<List<String>> doseAmtList = drugAlert.getDoseAmtList();
                if (CollUtil.isNotEmpty(doseAmtList)) {
                    int maxNum = Integer.MIN_VALUE;
                    for (List<String> list : doseAmtList) {
                        String name = list.get(1);
                        String num = list.get(2);
                        try {
                            int parseInt = Integer.parseInt(num);
                            countDoseAmt += parseInt;
                            if (parseInt > maxNum) {
                                if (!"unknown".equals(name)) {
                                    maxNum = parseInt;
                                    maxdoseAmt = "给药剂量大多分布在" + name + "。";
                                }
                            }
                        } catch (NumberFormatException e) {
                            log.error("将字符串类型的数量转化成int类型异常");
                        }
                        String percentage = list.get(3);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        doseAmt.add(inner);
                    }
                    int dValue = allNum - countDoseAmt;
                    if (dValue > 0) {
                        for (int i1 = 0; i1 < doseAmt.size(); i1++) {
                            JSONObject amtJSONObject = doseAmt.getJSONObject(i1);
                            String name = amtJSONObject.getString("name");
                            String num = amtJSONObject.getString("num");
                            int anInt = Integer.parseInt(num);
                            if ("unknown".equals(name)) {
                                anInt = anInt + dValue;
                                amtJSONObject.put("num", String.valueOf(anInt));
                                break;
                            }
                        }
                    }
                }
                result.getJSONObject("drugAnalysis").getJSONObject("usageAndDosage").put("doseAmt", doseAmt);
                if (StringUtils.isNotEmpty(maxDrug) || StringUtils.isNotEmpty(maxForm) || StringUtils.isNotEmpty(maxRoute) || StringUtils.isNotEmpty(maxdoseAmt)) {
                    StringBuilder usageAndDosageExplain = new StringBuilder();
                    usageAndDosageExplain.append("在").append(dataName).append("数据库数据库上报的不良反应报告中");
                    if (StringUtils.isNotEmpty(maxDrug)) {
                        usageAndDosageExplain.append("，").append(maxDrug);
                    }
                    if (StringUtils.isNotEmpty(maxForm)) {
                        usageAndDosageExplain.append("，").append(maxForm);
                    }
                    if (StringUtils.isNotEmpty(maxRoute)) {
                        usageAndDosageExplain.append("，").append(maxRoute);
                    }
                    if (StringUtils.isNotEmpty(maxdoseAmt)) {
                        usageAndDosageExplain.append("，").append(maxdoseAmt);
                    }
                    result.getJSONObject("drugAnalysis").getJSONObject("usageAndDosage").put("usageAndDosageExplain", usageAndDosageExplain.toString().replaceAll("，，", "，"));
                }
                // 2、治疗时间/不良反应发生时间
                result.getJSONObject("drugAnalysis").put("time", new JSONObject());
                // 2-1 治疗持续时间分布 dur_list
                JSONArray durTime = new JSONArray();
                String maxDruTime = "";
                List<List<String>> durList = drugAlert.getDurList();
                if (CollUtil.isNotEmpty(durList)) {
                    int maxNum = Integer.MIN_VALUE;
                    for (List<String> list : durList) {
                        String name = list.get(1);
                        String num = list.get(2);
                        try {
                            int parseInt = Integer.parseInt(num);
                            if (parseInt > maxNum) {
                                if (!"unknown".equals(name)) {
                                    maxNum = parseInt;
                                    maxDruTime = "治疗持续时间大多分布在" + name;
                                }
                            }
                        } catch (NumberFormatException e) {
                            log.error("将字符串类型的数量转化成int类型异常");
                        }
                        String percentage = list.get(3);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        durTime.add(inner);
                    }
                }
                result.getJSONObject("drugAnalysis").getJSONObject("time").put("durTime", durTime);
                // 2-2 不良反应时间分布 cut_dt_list
                JSONArray cutDtTime = new JSONArray();
                String maxCutDtTime = "";
                List<List<String>> cutDtList = drugAlert.getCutDtList();
                if (CollUtil.isNotEmpty(cutDtList)) {
                    int maxNum = Integer.MIN_VALUE;
                    for (List<String> list : cutDtList) {
                        String name = list.get(1);
                        String num = list.get(2);
                        try {
                            int parseInt = Integer.parseInt(num);
                            if (parseInt > maxNum) {
                                if (!"unknown".equals(name) && !"Other".equals(name)) {
                                    maxNum = parseInt;
                                    //maxCutDtTime = "使用后，不良反应发生时间多为" + name;
                                    maxCutDtTime = "不良反应发生时间多为" + name;
                                }
                            }
                        } catch (NumberFormatException e) {
                            log.error("将字符串类型的数量转化成int类型异常");
                        }
                        String percentage = list.get(3);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        cutDtTime.add(inner);
                    }
                }
                result.getJSONObject("drugAnalysis").getJSONObject("time").put("cutDtTime", cutDtTime);
                if (StringUtils.isNotEmpty(maxDruTime) || StringUtils.isNotEmpty(maxCutDtTime)) {
                    StringBuilder timeExplain = new StringBuilder();
                    timeExplain.append("在").append(dataName).append("数据库数据库上报的不良反应报告中，使用").append(originalI).append("后，");
                    if (StringUtils.isNotEmpty(maxDruTime)) {
                        timeExplain.append("，").append(maxDruTime);
                    }
                    if (StringUtils.isNotEmpty(maxCutDtTime)) {
                        timeExplain.append("，").append(maxCutDtTime);
                    }
                    result.getJSONObject("drugAnalysis").getJSONObject("time").put("timeExplain", timeExplain.toString().replaceAll("，，", "，"));
                }
                // 3、适应症分布 indi_pt_list
                JSONArray indiPt = new JSONArray();
                String maxIndiPt1 = "";
                String maxIndiPt2 = "";
                List<List<String>> indiPtList = drugAlert.getIndiPtList();
                if (CollUtil.isNotEmpty(indiPtList)) {
                    maxIndiPt1 = indiPtList.get(0).get(2);
                    int index = 1;
                    while (maxIndiPt1.contains("未知") && indiPtList.size() > index) {
                        maxIndiPt1 = indiPtList.get(index).get(2);
                        index++;
                    }
                    if (indiPtList.size() > index) {
                        maxIndiPt2 = indiPtList.get(index).get(2);
                        index++;
                        while (maxIndiPt2.contains("未知") && indiPtList.size() > index) {
                            maxIndiPt2 = indiPtList.get(index).get(2);
                            index++;
                        }
                    }
                    for (List<String> list : indiPtList) {
                        String englishName = list.get(1);
                        String name = list.get(2);
                        String num = list.get(3);
                        String percentage = list.get(4);
                        JSONObject inner = new JSONObject();
                        inner.put("englishName", englishName);
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        indiPt.add(inner);
                    }
                }
                result.getJSONObject("drugAnalysis").put("indiPt", indiPt);
                if (StringUtils.isNotEmpty(maxIndiPt1)) {
                    StringBuilder indiPtBuilder = new StringBuilder();
                    indiPtBuilder.append("在").append(dataName).append("数据库数据库上报的不良反应报告中，使用").append(originalI).append("的适应症最多的是").append(maxIndiPt1);
                    if (StringUtils.isNotEmpty(maxIndiPt2)) {
                        indiPtBuilder.append("其次是").append(maxIndiPt2);
                    }
                    indiPtBuilder.append("。");
                    result.getJSONObject("drugAnalysis").put("indiPtExplain", indiPtBuilder.toString().replaceAll("，，", "，"));
                }

                //======================不良反应及信号分析===========================
                result.put("adverseReactionSignal", new JSONObject());
                // 1、不良反应分析 pt_list
                JSONArray ptData = new JSONArray();
                List<List<String>> ptList = drugAlert.getPtList();
                String maxPt = "";
                int ptNum = 0;
                if (CollUtil.isNotEmpty(ptList)) {
                    String pt = drugAlert.getPt();
                    try {
                        String[] split = pt.split(",");
                        ptNum = split.length;
                    } catch (Exception e) {
                        ptNum = ptList.size();
                    }
                    if (ptList.size() > 2) {
                        maxPt = ptList.get(0).get(1) + "、" + ptList.get(1).get(1) + "和" + ptList.get(2).get(1) + "等";
                    } else if (ptList.size() > 1) {
                        maxPt = ptList.get(0).get(1) + "和" + ptList.get(1).get(1);
                    } else {
                        maxPt = ptList.get(0).get(1);
                    }
                    for (List<String> list : ptList) {
                        String englishName = list.get(0);
                        String name = list.get(1);
                        String num = list.get(2);
                        String percentage = list.get(3);
                        String diseaseType = list.get(4);
                        JSONObject inner = new JSONObject();
                        inner.put("englishName", englishName);
                        inner.put("name", name);
                        inner.put("num", num);
                        inner.put("percentage", percentage);
                        inner.put("diseaseType", diseaseType);
                        ptData.add(inner);
                    }
                }
                result.getJSONObject("adverseReactionSignal").put("pt", ptData);
                if (StringUtils.isNotEmpty(maxPt)) {
                    result.getJSONObject("adverseReactionSignal").put("ptExplain", "在" + dataName + "数据库数据库上报的不良反应报告中，监测出不良反应共有" + ptNum + "个，其中最常见的有" + maxPt);
                }
                // 2、典型信号分析 signal_dict i和i+o显示的效果不同
                //保存用于计算信号图i和o
                boolean flagPicture = true;
                List<JSONObject> pictureCondition = new ArrayList<>();
                if (conditionType == 1) {
                    //i+o
                    flagPicture = false;
                    Adrs adrs = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(i).and("description").is(condition.getO())), Adrs.class);
                    String judge = "不属于";
                    if (adrs != null) {
                        String indicator = adrs.getIndicator();
                        if ("+".equals(indicator)) {
                            judge = "属于";
                            JSONObject inner = new JSONObject();
                            inner.put("i", i);
                            inner.put("o", condition.getO());
                            pictureCondition.add(inner);
                        }
                    }
                    result.getJSONObject("adverseReactionSignal").put("signalDictExplain", condition.getOriginalO() + judge + condition.getOriginalI() + "的典型不良反应");
                } else {
                    //i
                    JSONArray signalDictData = new JSONArray();
                    Map<String, List<List<String>>> signalDict = drugAlert.getSignalDict();
                    //分类总数
                    int typeCount = 0;
                    //信号总数
                    int numCount = 0;
                    if (CollUtil.isNotEmpty(signalDict)) {
                        typeCount = signalDict.size();
                        //Eye disorders ( 眼器官疾病 )
                        Set<Map.Entry<String, List<List<String>>>> entries = signalDict.entrySet();
                        for (Map.Entry<String, List<List<String>>> entry : entries) {
                            String key = entry.getKey();
                            List<List<String>> value = entry.getValue();
                            String[] split = key.split("\\(");
                            String name = split[1].replaceAll("\\)", "").trim();
                            if (!GetMaxSimilarUtil.judgeChinese(name)) {
                                name = split[2].replaceAll("\\)", "").trim();
                            }
                            for (List<String> list : value) {
                                numCount++;
                                JSONObject innerJson = new JSONObject();
                                String innerName = list.get(1);
                                String englishName = list.get(0);
                                String num = list.get(2);
                                String ror = list.get(3);
                                String ebgm = list.get(4);
                                String ic = list.get(5);
                                innerJson.put("outEnglishName", key);
                                innerJson.put("englishName", englishName);
                                innerJson.put("name", innerName);
                                innerJson.put("num", num);
                                //计算占比
                                try {
                                    long aLong = Long.parseLong(num);
                                    double doubleValue = BigDecimal.valueOf(aLong).divide(BigDecimal.valueOf(allNum), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue();
                                    innerJson.put("percentage", doubleValue + "%");
                                } catch (NumberFormatException e) {
                                    log.error("计算单个不良反应的百分比时数量转换异常[{}]", num);
                                    innerJson.put("percentage", "0%");
                                }
                                innerJson.put("outName", name);
                                //outName单纯英文显示
                                String outEnglish = key.replaceAll("\\( "+name+" \\)", "").trim();
                                innerJson.put("outEnglish", outEnglish);
                                if (ror.contains(".")) {
                                    int rorIndex = ror.indexOf(".");
                                    try {
                                        innerJson.put("ror", ror.substring(0, rorIndex + 3));
                                    } catch (Exception e) {
                                        e.printStackTrace();
                                        innerJson.put("ror", ror);
                                    }
                                }else {
                                    innerJson.put("ror", ror);
                                }
                                if (ebgm.contains(".")) {
                                    int ebgmIndex = ebgm.indexOf(".");
                                    try {
                                        innerJson.put("ebgm", ebgm.substring(0, ebgmIndex + 3));
                                    } catch (Exception e) {
                                        e.printStackTrace();
                                        innerJson.put("ebgm", ebgm);
                                    }
                                }else {
                                    innerJson.put("ebgm", ebgm);
                                }
                                if (ic.contains(".")) {
                                    int icIndex = ic.indexOf(".");
                                    try {
                                        innerJson.put("ic", ic.substring(0, icIndex + 3));
                                    } catch (Exception e) {
                                        e.printStackTrace();
                                        innerJson.put("ic", ic);
                                    }
                                }else {
                                    innerJson.put("ic", ic);
                                }
                                //存放i+o
                                innerJson.put("i", i);
                                innerJson.put("o", englishName);
                                //中文名
                                //innerJson.put("name", innerName);
                                signalDictData.add(innerJson);
                            }
                        }
                    }
                    //按照ror排序并取前50
                    if (!signalDictData.isEmpty()) {
                        List<JSONObject> list = JSONArray.parseArray(JSONObject.toJSONString(signalDictData), JSONObject.class);
                        list.sort((o1, o2) -> {
                            double ror1 = Double.parseDouble(o1.getString("ic"));
                            double ror2 = Double.parseDouble(o2.getString("ic"));
                            return Double.compare(ror2, ror1);
                        });
                        if (list.size() > 50) {
                            list = list.subList(0, 50);
                        }
                        //取前3作为下一步检索条件检索时间扫描图
                        int num = 0;
                        for (JSONObject jsonObject : list) {
                            if (num >= 3) {
                                break;
                            }
                            pictureCondition.add(jsonObject);
                            num++;
                        }
                        signalDictData = JSONArray.parseArray(JSONObject.toJSONString(list));
                    }
                    result.getJSONObject("adverseReactionSignal").put("signalDict", signalDictData);
                    result.getJSONObject("adverseReactionSignal").put("signalDictExplain", "在"+dataName+"数据库数据库上报的不良反应报告中，监测出不良反应信号共有"+numCount+"个。");
                    result.getJSONObject("adverseReactionSignal").put("signalDictTypeCount", typeCount);
                    result.getJSONObject("adverseReactionSignal").put("signalDictNumCount", numCount);
                }
                // 3、时间扫描图谱
                List<JSONObject> picture = new ArrayList<>();
                if (CollUtil.isNotEmpty(pictureCondition)) {
                    for (JSONObject jsonObject : pictureCondition) {
                        String dataI = jsonObject.getString("i");
                        String dataO = jsonObject.getString("o");
                        String ror = jsonObject.getString("ror");
                        String ic = jsonObject.getString("ic");
                        JSONObject one = mongoTemplate.findOne(new Query(Criteria.where("drugname").is(dataI).and("pt").is(dataO)), JSONObject.class, TableEnum.PictureForDrug.getMsg());
                        if (one == null) {
                            one = mongoTemplate.findOne(new Query(Criteria.where("drugname").is(dataI).and("pt").is(dataO)), JSONObject.class, TableEnum.PictureForProdAi.getMsg());
                        }
                        if (one != null) {
                            if (flagPicture) {
                                one.put("ror", ror);
                                one.put("ic", ic);
                            }
                            one.put("i", dataI);
                            one.put("o", dataO);
                            picture.add(one);
                        }
                    }
                }
                JSONArray allArray = new JSONArray();
                if (CollUtil.isNotEmpty(picture)) {
                    for (JSONObject json : picture) {
                        JSONObject inner = new JSONObject();
                        String ptName = json.getString("pt");
                        JSONArray icList = json.getJSONArray("ic_list");
                        JSONArray timeList = json.getJSONArray("quarter_list");
                        JSONArray yerrIcList = json.getJSONArray("yerr_ic_list");
                        String start = timeList.getString(0);
                        String end = timeList.getString(timeList.size() - 1);
                        String title = start + "-" + end + "年" + ptName + "安全信号的时间扫描";
                        //误差集合
                        JSONArray errorArr = new JSONArray();
                        JSONArray icArr = new JSONArray();
                        for (int i1 = 0; i1 < icList.size(); i1++) {
                            JSONArray innerArr = new JSONArray();
                            //保留两位小数
                            DecimalFormat format = new DecimalFormat("#.00");
                            Double aDouble = icList.getDouble(i1);
                            aDouble = Double.valueOf(format.format(aDouble));
                            Double error = yerrIcList.getDouble(i1);
                            error = Double.valueOf(format.format(error));
                            icArr.add(aDouble);
                            innerArr.add(i1);
                            innerArr.add(BigDecimal.valueOf(aDouble).subtract(BigDecimal.valueOf(error)).divide(BigDecimal.ONE, 2, RoundingMode.HALF_UP).doubleValue());
                            innerArr.add(BigDecimal.valueOf(aDouble).add(BigDecimal.valueOf(error)).divide(BigDecimal.ONE, 2, RoundingMode.HALF_UP).doubleValue());
                            errorArr.add(innerArr);
                        }
                        inner.put("title", title);
                        inner.put("y", icArr);
                        inner.put("x", timeList);
                        inner.put("error", errorArr);
                        if (flagPicture) {
                            inner.put("ror", json.getString("ror"));
                            inner.put("ic", json.getString("ic"));
                        }
                        inner.put("i", json.getString("i"));
                        inner.put("o", json.getString("o"));
                        allArray.add(inner);
                    }
                }
                result.getJSONObject("adverseReactionSignal").put("picture", allArray);
                result.getJSONObject("adverseReactionSignal").put("pictureFlag", flagPicture);

                //===========================结局分析=============================
                result.put("outcomeAnalysis", new JSONObject());
                // 严重不良反应结局 outc_cod_list
                List<List<String>> outCodList = drugAlert.getOutCCodList();
                JSONArray adverseReactions = new JSONArray();
                //严重不良反应数量
                String max1 = "";
                String max2 = "";
                if (CollUtil.isNotEmpty(outCodList)) {
                    if (CollUtil.isNotEmpty(outCodList)) {
                        max1 = outCodList.get(0).get(1);
                        if (outCodList.size() > 1) {
                            max2 = outCodList.get(1).get(1);
                        }
                        for (List<String> list : outCodList) {
                            String name = list.get(1);
                            String num = list.get(2);
                            String percentage = list.get(3);
                            JSONObject inner = new JSONObject();
                            inner.put("name", name);
                            inner.put("num", num);
                            inner.put("percentage", percentage);
                            adverseReactions.add(inner);
                        }
                    }
                }
                result.getJSONObject("outcomeAnalysis").put("adverseReactions", adverseReactions);
                //计算严重不良反应占比 严重 非严重
                Map<String, Integer> outCodCount = drugAlert.getOutCCodCount();
                if (CollUtil.isNotEmpty(outCodCount)) {
                    Integer adverseNum = outCodCount.get("yes");
                    Integer nonAdverseNum = outCodCount.get("no");
                    int totalNum = adverseNum + nonAdverseNum;
                    JSONArray adversePercentage = new JSONArray();
                    JSONObject innerAdverse1 = new JSONObject();
                    double doubleValue1 = BigDecimal.valueOf(adverseNum).divide(BigDecimal.valueOf(totalNum), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue();
                    innerAdverse1.put("name", "严重不良反应");
                    innerAdverse1.put("num", adverseNum);
                    innerAdverse1.put("percentage", doubleValue1 + "%");
                    adversePercentage.add(innerAdverse1);
                    JSONObject innerAdverse2 = new JSONObject();
                    innerAdverse2.put("name", "非严重不良反应");
                    innerAdverse2.put("num", nonAdverseNum);
                    BigDecimal doubleValue2 = BigDecimal.valueOf(100).subtract(BigDecimal.valueOf(doubleValue1)).divide(BigDecimal.valueOf(1), 2, RoundingMode.HALF_UP);
                    innerAdverse2.put("percentage", doubleValue2 + "%");
                    adversePercentage.add(innerAdverse2);
                    result.getJSONObject("outcomeAnalysis").put("adversePercentage", adversePercentage);
                    if (StringUtils.isNotEmpty(max1)) {
                        StringBuilder inner = new StringBuilder();
                        inner.append("在").append(dataName).append("数据库数据库上报的不良反应报告中，严重不良反应占比为").append(doubleValue1).append("%，其中").append(max1).append("占比最高");
                        if (StringUtils.isNotEmpty(max2)) {
                            inner.append("，其次是").append(max2);
                        }
                        inner.append("。");
                        result.getJSONObject("outcomeAnalysis").put("adverseExplain", inner.toString());
                    }
                }
                // 治疗和转归 dechal rechal
                List<List<String>> dechal = drugAlert.getDechal();
                JSONObject dechalAndRechal = new JSONObject();
                JSONArray dechalData = new JSONArray();
                String dechalExplain = "";
                if (CollUtil.isNotEmpty(dechal)) {
                    String maxDechal = "";
                    int maxDechalNum = Integer.MIN_VALUE;
                    String minDechal = "";
                    int minDechalNum = Integer.MAX_VALUE;
                    for (List<String> list : dechal) {
                        String name = list.get(0);
                        String num = list.get(1);
                        String percentage = list.get(2);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        try {
                            int anInt = Integer.parseInt(num);
                            if (anInt > maxDechalNum) {
                                maxDechalNum = anInt;
                                maxDechal = name;
                            }
                            if (anInt < minDechalNum) {
                                minDechalNum = anInt;
                                minDechal = name;
                            }
                        } catch (NumberFormatException e) {
                            e.printStackTrace();
                        }
                        inner.put("percentage", percentage);
                        dechalData.add(inner);
                    }
                    dechalExplain = "，停药或减药后的反应占比最高的是" + maxDechal;
                    if (dechal.size() > 1) {
                        dechalExplain = dechalExplain + "，" + minDechal + "的占比最少";
                    }

                }
                dechalAndRechal.put("停药或减药后反应是否减轻或消失", dechalData);
                List<List<String>> rechal = drugAlert.getRechal();
                JSONArray rechalData = new JSONArray();
                String rechalExplain = "";
                if (CollUtil.isNotEmpty(rechal)) {
                    String maxRechal = "";
                    int maxRechalNum = Integer.MIN_VALUE;
                    String minRechal = "";
                    int minRechalNum = Integer.MAX_VALUE;
                    for (List<String> list : rechal) {
                        String name = list.get(0);
                        String num = list.get(1);
                        String percentage = list.get(2);
                        JSONObject inner = new JSONObject();
                        inner.put("name", name);
                        inner.put("num", num);
                        try {
                            int anInt = Integer.parseInt(num);
                            if (anInt > maxRechalNum) {
                                maxRechalNum = anInt;
                                maxRechal = name;
                            }
                            if (anInt < minRechalNum) {
                                minRechalNum = anInt;
                                minRechal = name;
                            }
                        } catch (NumberFormatException e) {
                            e.printStackTrace();
                        }
                        inner.put("percentage", percentage);
                        rechalData.add(inner);
                    }
                    rechalExplain = "；重新使用药物后的反应占比最高的是" + maxRechal;
                    if (rechal.size() > 1) {
                        rechalExplain = rechalExplain + "，" + minRechal + "的占比最少";
                    }
                }
                dechalAndRechal.put("重新使用药物反应是否再次出现", rechalData);
                result.getJSONObject("outcomeAnalysis").put("dechalAndRechal", dechalAndRechal);
                if (StringUtils.isNotEmpty(dechalExplain)) {
                    StringBuilder inner = new StringBuilder();
                    inner.append("在").append(dataName).append("数据库数据库上报的不良反应报告中");
                    inner.append(dechalExplain);
                    if (StringUtils.isNotEmpty(rechalExplain)) {
                        inner.append(rechalExplain);
                    }
                    inner.append("。");
                    result.getJSONObject("outcomeAnalysis").put("dechalAndRechalExplain", inner.toString());
                }
            } else {
                if (type == 1) {
                    result.put("adverseReactionSignal", new JSONObject().put("signalDictExplain", condition.getOriginalO() + "不属于" + condition.getOriginalI() + "的典型不良反应"));
                }
                // 3、时间扫描图谱
               /* List<JSONObject> picture;
                if (conditionType == 1){
                    //i+o
                    picture = mongoTemplate.find(new Query(Criteria.where("drugname").is(i).and("pt").is(condition.getO())), JSONObject.class, TableEnum.PictureForDrug.getMsg());
                }else {
                    //i
                    picture = mongoTemplate.find(new Query(Criteria.where("drugname").is(i)), JSONObject.class, TableEnum.PictureForDrug.getMsg());
                }
                if (CollUtil.isEmpty(picture)){
                    if (conditionType == 1){
                        //i+o
                        picture = mongoTemplate.find(new Query(Criteria.where("drugname").is(i).and("pt").is(condition.getO())), JSONObject.class, TableEnum.PictureForProdAi.getMsg());
                    }else {
                        //i
                        picture = mongoTemplate.find(new Query(Criteria.where("drugname").is(i)), JSONObject.class, TableEnum.PictureForProdAi.getMsg());
                    }
                }
                JSONArray allArray = new JSONArray();
                if (CollUtil.isNotEmpty(picture)){
                    for (JSONObject json : picture) {
                        JSONObject inner = new JSONObject();
                        String drugname = json.getString("drugname");
                        JSONArray rorList = json.getJSONArray("ror_list");
                        JSONArray timeList = json.getJSONArray("year_list");
                        String start = timeList.getString(0);
                        String end = timeList.getString(timeList.size() - 1);
                        String title = start + "-" + end + "年" + drugname + "安全信号的时间扫描";
                        inner.put("title", title);
                        inner.put("y", rorList);
                        inner.put("x", timeList);
                        allArray.add(inner);
                    }
                }
                result.put("adverseReactionSignal", new JSONObject().put("picture", allArray));*/
                //判断是否全无数据
                JSONObject basicInformation = result.getJSONObject("basicInformation");
                JSONObject drugAnalysis = result.getJSONObject("drugAnalysis");
                JSONObject adverseReactionSignal = result.getJSONObject("adverseReactionSignal");
                JSONObject outcomeAnalysis = result.getJSONObject("outcomeAnalysis");
                if (CollUtil.isEmpty(basicInformation) && CollUtil.isEmpty(drugAnalysis) && CollUtil.isEmpty(adverseReactionSignal) && CollUtil.isEmpty(outcomeAnalysis)) {
                    //及VigiAccess
                    String time;
                    if ("VigiAccess".equals(dataName)) {
                        time = "2022/01/31";
                    } else {
                        time = "2022/12/31";
                    }
                    result.put("explain", dataName + "数据库由建库开始至“" + time + "”期间上报的所有不良反应数据中，均未找到“" + condition.getCondition() + "”相关的不良反应信息。");
                }
            }
        }
        return result;
    }

    @Override
    public void download(String id, HttpServletResponse response) throws DocumentException, IOException {
        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");
        response.setHeader("Content-Disposition", "attachment;fileName=" + DateUtil.format(new Date(), "yyyyMMddHHmmss") + ".pdf");
        ServletOutputStream outputStream = response.getOutputStream();
        //创建一个文档（默认大小A4，边距36, 36, 36, 36）
        Document document = new Document();
        //设置文档大小
        document.setPageSize(PageSize.A4);
        document.setMargins(50, 50, 50, 50);
        //创建writer，通过writer将文档写入磁盘
        PdfWriter writer = PdfWriter.getInstance(document, outputStream);
        writer.setStrictImageSequence(true);
        //writer.setViewerPreferences(Element.JBIG2);
        //打开文档，只有打开后才能往里面加东西
        document.open();
        //设置报告名称
        Paragraph paragraphTitle = createHead(43, "药品安全性分析报告", Element.ALIGN_LEFT);
        //设置对齐方式
        paragraphTitle.setAlignment(Element.ALIGN_LEFT);
        paragraphPosition(writer, paragraphTitle, 120, 500, 530, 600);
        //设置公司名称
        Paragraph paragraphName = createHead(23, "灵犀量子（北京）医疗科技有限公司", Element.ALIGN_LEFT);
        paragraphName.setAlignment(Element.ALIGN_LEFT);
        paragraphPosition(writer, paragraphName, 120, 100, 530, 150);
        //设置标题时间
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd");
        String formatTime = format.format(new Date());
        Font timeFont = createFont(23, Font.NORMAL);
        Paragraph paragraphTime = new Paragraph(formatTime, timeFont);
        paragraphTime.setAlignment(Element.ALIGN_CENTER);
        paragraphPosition(writer, paragraphTime, 130, 50, 480, 100);
        //开始新开一页进行正文的拼接
        document.newPage();
        //创建完成新的页之后如果不添加内容的话，会忽略新添加的页
        Condition condition = mongoTemplate.findById(id, Condition.class);
        //1-i+o 2-i
        Integer type = 1;
        //用户输入条件
        String conditionData = "";
        String originalI = "";
        String originalO = "";
        String i = "";
        String o = "";
        if (condition != null) {
            originalI = condition.getOriginalI();
            originalO = condition.getOriginalO();
            i = condition.getI();
            o = condition.getO();
            conditionData = condition.getCondition();
            type = condition.getType();
        }
        //fda
        JSONObject fda = searchAll(id, 1);
        //vigi
        JSONObject vigi;
        if (type == 1) {
            vigi = new JSONObject();
        } else {
            vigi = searchAll(id, 2);
        }
        //分析综述 analysisOverview
        JSONObject analysisOverview = analysisOverview(id, 1);

        //2.1 基本情况数据
        //不良反应报告总数
        int allNum = 0;
        //性别
        JSONObject sexDataFda = new JSONObject();
        JSONObject sexDataVigi = new JSONObject();
        //年龄
        JSONObject ageDataFda = new JSONObject();
        JSONObject ageDataVigi = new JSONObject();
        //报告国家
        JSONObject countryDataFda = new JSONObject();
        JSONObject countryDataVigi = new JSONObject();
        //职业
        JSONObject reportDataFda = new JSONObject();
        //不良反应逐年上报情况
        JSONObject reportYearDataFda = new JSONObject();
        JSONObject reportYearDataVigi = new JSONObject();
        //严重不良反应
        JSONObject adverseReactionsDataFda = new JSONObject();
        JSONObject adverseReactionsDataVigi = new JSONObject();
        //2.1结论
        StringBuilder builder21Fda = new StringBuilder();
        StringBuilder builder21Vigi = new StringBuilder();
        //2.2 用药情况分析
        //剂型
        JSONObject doseFormDataFda = new JSONObject();
        //给药途径
        JSONObject routeDataFda = new JSONObject();
        //给药剂量
        JSONObject doseAmtDataFda = new JSONObject();
        //持续用药时间
        JSONObject durTimeDataFda = new JSONObject();
        //2.2结论
        StringBuilder builder22Fda = new StringBuilder();
        //2.3 用药适应征分析
        List<List<String>> indiPtList = new ArrayList<>();
        StringBuilder builder23Fda = new StringBuilder();
        StringBuilder builder23FdaExplain = new StringBuilder();
        //2.4 给药方案及不良反应发生时间分布
        //给药方案
        JSONObject drugNumData = new JSONObject();
        //不良反应发生时间分布
        JSONObject cutDtTimeData = new JSONObject();
        StringBuilder builder24Fda = new StringBuilder();
        StringBuilder builder24FdaExplain = new StringBuilder();
        //2.5 治疗与转归
        Map<String, List<List<String>>> dechalAndRechalMap = new LinkedHashMap<>();
        StringBuilder builder25Fda = new StringBuilder();
        StringBuilder builder25FdaExplain = new StringBuilder();
        //3.1 不良反应分析结果
        List<List<String>> ptFdaList = new ArrayList<>();
        List<List<String>> ptVigiList = new ArrayList<>();
        StringBuilder builder31Fda = new StringBuilder();
        StringBuilder builder31Vigi = new StringBuilder();
        //3.2 各系统器官分类的ADR信号数及ADEs报告数
        Map<String, List<List<String>>> signalDictFdaMap = new HashMap<>();
        Map<String, String> signalDictFdaOnlyMap = new HashMap<>();
        String signalDictExplain = "";
        Map<String, List<List<String>>> signalDictVigiMap = new HashMap<>();
        Map<String, String> signalDictVigiOnlyMap = new HashMap<>();
        StringBuilder builder32Fda = new StringBuilder();
        StringBuilder builder32Vigi = new StringBuilder();
        //3.3 药物-ADEs 组合的时间扫描图谱
        JSONArray pictureArr = new JSONArray();
        StringBuilder builderPicture = new StringBuilder();
        if (CollUtil.isNotEmpty(fda) || CollUtil.isNotEmpty(vigi)) {
            if (!fda.isEmpty()) {
                //基本情况数据
                JSONObject basicInformation = fda.getJSONObject("basicInformation");
                if (CollUtil.isNotEmpty(basicInformation)) {
                    //不良反应报告总数
                    allNum = basicInformation.getInteger("allNum");
                    builder21Fda.append("FAERS数据库共获得不良反应报告").append(allNum).append("例。在已知的数据中：");
                    //人群分布
                    JSONObject populationDistribution = basicInformation.getJSONObject("populationDistribution");
                    if (CollUtil.isNotEmpty(populationDistribution)) {
                        //性别
                        JSONArray reportSex = populationDistribution.getJSONArray("reportSex");
                        if (CollUtil.isNotEmpty(reportSex)) {
                            String man = "0%";
                            String woman = "0%";
                            String maxSex = "";
                            int maxSexNum = Integer.MIN_VALUE;
                            for (int i1 = 0; i1 < reportSex.size(); i1++) {
                                JSONObject json = reportSex.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                if (!"未知".equals(name)) {
                                    try {
                                        int anInt = Integer.parseInt(num);
                                        if (anInt > maxSexNum) {
                                            maxSexNum = anInt;
                                            maxSex = name;
                                        }
                                    } catch (NumberFormatException e) {
                                        e.printStackTrace();
                                    }
                                }
                                String percentage = json.getString("percentage");
                                if ("男".equals(name)) {
                                    man = percentage;
                                }
                                if ("女".equals(name)) {
                                    woman = percentage;
                                }
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                sexDataFda.put(name, inner);
                            }
                            builder21Fda.append("性别构成上，男性（").append(man).append("）").append("男".equals(maxSex) ? "大于" : "小于").append("女性（").append(woman).append("）；");
                        }
                        //年龄
                        JSONArray reportAge = populationDistribution.getJSONArray("reportAge");
                        if (CollUtil.isNotEmpty(reportAge)) {
                            builder21Fda.append("；");
                            String maxAge = "";
                            String maxPercentage = "";
                            int maxAgeNum = Integer.MIN_VALUE;
                            for (int i1 = 0; i1 < reportAge.size(); i1++) {
                                JSONObject json = reportAge.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                try {
                                    int anInt = Integer.parseInt(num);
                                    if (anInt > maxAgeNum) {
                                        if (!"未知".equals(name)) {
                                            maxAgeNum = anInt;
                                            maxAge = name;
                                            maxPercentage = percentage;
                                        }
                                    }
                                } catch (NumberFormatException e) {
                                    e.printStackTrace();
                                }

                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                ageDataFda.put(name, inner);
                            }
                            builder21Fda.append("年龄主要集中在").append(maxAge).append("（").append(maxPercentage).append("）");
                        }
                    }
                    //报告分布
                    JSONObject reportDistribution = basicInformation.getJSONObject("reportDistribution");
                    if (CollUtil.isNotEmpty(reportDistribution)) {
                        //不良反应逐年上报情况
                        JSONArray reportYear = reportDistribution.getJSONArray("reportYear");
                        if (CollUtil.isNotEmpty(reportYear)) {
                            for (int i1 = 0; i1 < reportYear.size(); i1++) {
                                JSONObject json = reportYear.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                reportYearDataFda.put(name, inner);
                            }
                        }
                        //地区分布
                        JSONArray reportCountry = reportDistribution.getJSONArray("reportCountry");
                        if (CollUtil.isNotEmpty(reportCountry)) {
                            int maxIntCountry = Integer.MIN_VALUE;
                            builder21Fda.append("；");
                            String maxCountry = "";
                            String asiaNum = "";
                            for (int i1 = 0; i1 < reportCountry.size(); i1++) {
                                JSONObject json = reportCountry.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                if ("亚洲".equals(name)) {
                                    asiaNum = num;
                                }
                                try {
                                    int anInt = Integer.parseInt(num);
                                    if (!"未知".equals(name)) {
                                        if (anInt > maxIntCountry) {
                                            maxIntCountry = anInt;
                                            maxCountry = name;
                                        }
                                    }
                                } catch (NumberFormatException e) {
                                    e.printStackTrace();
                                }
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                countryDataFda.put(name, inner);
                            }
                            builder21Fda.append(maxCountry).append("报告数最多").append("，亚洲的报告数有").append(asiaNum).append("份");
                        }
                        //职业分布
                        JSONArray reportOccupation = reportDistribution.getJSONArray("reportOccupation");
                        if (CollUtil.isNotEmpty(reportOccupation)) {
                            builder21Fda.append("；");
                            String maxOccupation = reportOccupation.getJSONObject(0).getString("name");
                            if ("未知".equals(maxOccupation) && reportOccupation.size() > 1) {
                                maxOccupation = reportOccupation.getJSONObject(1).getString("name");
                            }
                            for (int i1 = 0; i1 < reportOccupation.size(); i1++) {
                                JSONObject json = reportOccupation.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                reportDataFda.put(name, inner);
                            }
                            if (StringUtils.isNotBlank(maxOccupation) && !"未知".equals(maxOccupation)){
                                builder21Fda.append("上报者主要为").append(maxOccupation);
                            }
                        }
                    }
                }
                //严重不良反应分布
                JSONObject outcomeAnalysis = fda.getJSONObject("outcomeAnalysis");
                if (CollUtil.isNotEmpty(outcomeAnalysis)) {
                    //严重不良反应结局
                    JSONArray adverseReactions = outcomeAnalysis.getJSONArray("adverseReactions");
                    if (CollUtil.isNotEmpty(adverseReactions)) {
                        builder21Fda.append("；");
                        String maxOccupation = adverseReactions.getJSONObject(0).getString("name");
                        String maxNum = adverseReactions.getJSONObject(0).getString("num");
                        String maxPercentage = adverseReactions.getJSONObject(0).getString("percentage");
                        for (int i1 = 0; i1 < adverseReactions.size(); i1++) {
                            JSONObject json = adverseReactions.getJSONObject(i1);
                            String name = json.getString("name");
                            String num = json.getString("num");
                            String percentage = json.getString("percentage");
                            JSONObject inner = new JSONObject();
                            inner.put("name", name);
                            inner.put("num", num);
                            inner.put("percentage", percentage);
                            adverseReactionsDataFda.put(name, inner);
                        }
                        builder21Fda.append(originalI).append(" 严重不良反应结局中以").append(maxOccupation).append("报告数最多（").append(maxNum).append("例，").append(maxPercentage).append("）");
                    }
                    //治疗和转归
                    JSONObject dechalAndRechal = outcomeAnalysis.getJSONObject("dechalAndRechal");
                    if (CollUtil.isNotEmpty(dechalAndRechal)) {
                        if (type == 1) {
                            //i+o
                            builder25Fda.append("FAERS数据库中，").append(originalI).append("致").append(originalO).append("的报告共有").append(allNum).append("例。");
                        } else {
                            //i
                            builder25Fda.append("FAERS数据库显示：在").append(allNum).append("份 ADEs 报告中，");
                        }
                        Set<String> set = dechalAndRechal.keySet();
                        //停药后消失
                        String stopDisappear = "";
                        //停药后再次出现
                        String stopAppear = "";
                        //重新用药后再次出现
                        String appear = "";
                        for (String s : set) {
                            List<List<String>> outList = new ArrayList<>();
                            JSONArray jsonArray = dechalAndRechal.getJSONArray(s);
                            for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                                JSONObject jsonObject = jsonArray.getJSONObject(i1);
                                String name = jsonObject.getString("name");
                                String num = jsonObject.getString("num");
                                String percentage = jsonObject.getString("percentage");
                                List<String> innerList = new ArrayList<>();
                                innerList.add(name);
                                innerList.add(num);
                                innerList.add(percentage);
                                outList.add(innerList);
                                if ("停药或减药后反应是否减轻或消失".equals(s)) {
                                    if (name.contains("（减轻、消失）")) {
                                        stopDisappear = percentage;
                                    }
                                    if (name.contains("（未消失或减轻）")) {
                                        stopAppear = percentage;
                                    }
                                } else {
                                    if (name.contains("（出现）")) {
                                        appear = percentage;
                                    }
                                }
                            }
                            dechalAndRechalMap.put(s, outList);
                        }
                        String anotherPercentage1 = "";
                        String anotherPercentage2 = "";
                        if (StringUtils.isNotEmpty(stopDisappear) && StringUtils.isNotEmpty(stopAppear)) {
                            try {
                                double v1 = Double.parseDouble(stopDisappear.split("%")[0]);
                                double v2 = Double.parseDouble(stopAppear.split("%")[0]);
                                anotherPercentage1 = (100 - v1 - v2) + "%";
                            } catch (NumberFormatException e) {
                                log.error("治疗与转归百分比转化异常[{}], [{}]", stopDisappear, stopAppear);
                            }
                        } else if (StringUtils.isNotEmpty(stopDisappear)) {
                            try {
                                double v1 = Double.parseDouble(stopDisappear.split("%")[0]);
                                anotherPercentage1 = (100 - v1) + "%";
                            } catch (NumberFormatException e) {
                                log.error("治疗与转归百分比转化异常[{}]", stopDisappear);
                            }
                        } else {
                            try {
                                double v2 = Double.parseDouble(stopAppear.split("%")[0]);
                                anotherPercentage1 = (100 - v2) + "%";
                            } catch (NumberFormatException e) {
                                log.error("治疗与转归百分比转化异常[{}]", stopAppear);
                            }
                        }
                        if (StringUtils.isNotEmpty(anotherPercentage1)) {
                            //取小数点后两位
                            anotherPercentage1 = BigDecimal.valueOf(Double.parseDouble(anotherPercentage1.split("%")[0])).divide(BigDecimal.valueOf(1), 2, RoundingMode.HALF_UP).doubleValue() + "%";
                        }
                        if (StringUtils.isNotEmpty(appear)) {
                            try {
                                double v2 = Double.parseDouble(appear.split("%")[0]);
                                anotherPercentage2 = (100 - v2) + "%";
                            } catch (NumberFormatException e) {
                                log.error("治疗与转归百分比转化异常[{}]", appear);
                            }
                        }
                        builder25Fda.append("停药或减药后反应减轻或消失的占比为").append(stopDisappear).append("，反应未减轻或未消失的占比为").append(stopAppear).append("，其余占比为").append(anotherPercentage1).append("；重新用药后反应再次出现的占比为").append(appear).append("其余的占比为").append(anotherPercentage2).append("。详见表 6。");
                        builder25FdaExplain.append("停药或减药后反应减轻或消失的占比为").append(stopDisappear).append("，反应未减轻或未消失的占比为").append(stopAppear).append("，其余占比为").append(anotherPercentage1).append("；重新用药后反应再次出现的占比为").append(appear).append("其余的占比为").append(anotherPercentage2).append("。");
                    }
                }
                builder21Fda.append("。").append("其人口学特征及严重不良事件构成情况见表 1。不良反应逐年上报情况详见表 2。");
                //用药情况分析
                JSONObject drugAnalysis = fda.getJSONObject("drugAnalysis");
                if (CollUtil.isNotEmpty(drugAnalysis)) {
                    if (type == 1) {
                        //i+o
                        builder22Fda.append("FAERS数据库中，").append(originalI).append("致").append(originalO).append("的报告共有").append(allNum).append("例。在已知的数据中：");
                    } else {
                        //i
                        builder22Fda.append("FAERS数据库的").append(allNum).append("份 ADEs 报告，在已知数据中：");
                    }
                    //用法用量分析
                    JSONObject usageAndDosage = drugAnalysis.getJSONObject("usageAndDosage");
                    if (CollUtil.isNotEmpty(usageAndDosage)) {
                        //剂型分布 doseFormList
                        JSONArray doseFormList = usageAndDosage.getJSONArray("doseFormList");
                        if (CollUtil.isNotEmpty(doseFormList)) {
                            String maxDoseForm = doseFormList.getJSONObject(0).getString("name");
                            if ("unknown".equals(maxDoseForm) && doseFormList.size() > 1) {
                                maxDoseForm = doseFormList.getJSONObject(1).getString("name");
                            }
                            for (int i1 = 0; i1 < doseFormList.size(); i1++) {
                                JSONObject json = doseFormList.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                doseFormDataFda.put(name, inner);
                            }
                            if (StringUtils.isNotBlank(maxDoseForm) && !"unknown".equals(maxDoseForm)) {
                                builder22Fda.append("该药品报告最多的剂型为").append(maxDoseForm).append("；");
                            }
                        }
                        //给药用途分布 route
                        JSONArray route = usageAndDosage.getJSONArray("route");
                        if (CollUtil.isNotEmpty(route)) {
                            String maxRoute = route.getJSONObject(0).getString("name");
                            if ("未知".equals(maxRoute) && route.size() > 1) {
                                maxRoute = route.getJSONObject(1).getString("name");
                            }
                            for (int i1 = 0; i1 < route.size(); i1++) {
                                JSONObject json = route.getJSONObject(i1);
                                String name = json.getString("name");
                                String englishName = json.getString("englishName");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                routeDataFda.put(name + "（" + englishName + "）", inner);
                            }
                            if (StringUtils.isNotBlank(maxRoute) && !"未知".equals(maxRoute)) {
                                builder22Fda.append("给药途径报告最多的是").append(maxRoute).append("；");
                            }
                        }
                        //计量分布 doseAmt
                        JSONArray doseAmt = usageAndDosage.getJSONArray("doseAmt");
                        if (CollUtil.isNotEmpty(doseAmt)) {
                            String maxDoseAmt = doseAmt.getJSONObject(0).getString("name");
                            if ("unknown".equals(maxDoseAmt) && doseAmt.size() > 1) {
                                maxDoseAmt = doseAmt.getJSONObject(1).getString("name");
                            }
                            for (int i1 = 0; i1 < doseAmt.size(); i1++) {
                                JSONObject json = doseAmt.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                doseAmtDataFda.put(name, inner);
                            }
                            if (StringUtils.isNotBlank(maxDoseAmt) && !"unknown".equals(maxDoseAmt)) {
                                builder22Fda.append("最常用的给药剂量为").append(maxDoseAmt).append("；");
                            }
                        }
                        //给药方案 drugNumList
                        JSONArray drugNumList = usageAndDosage.getJSONArray("drugNumList");
                        if (CollUtil.isNotEmpty(drugNumList)) {
                            if (type == 1) {
                                //i+o
                                builder24Fda.append("FAERS数据库中，").append(originalI).append("致").append(originalO).append("的报告共有").append(allNum).append("例。");
                            } else {
                                //i
                                builder24Fda.append("FAERS数据库显示：在").append(allNum).append("份 ADEs 报告中，");
                            }
                            String maxDoseAmt = drugNumList.getJSONObject(0).getString("percentage");
                            String minDoseAmt = drugNumList.getJSONObject(1).getString("percentage");
                            for (int i1 = 0; i1 < drugNumList.size(); i1++) {
                                JSONObject json = drugNumList.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                drugNumData.put(name, inner);
                            }
                            builder24Fda.append("使用联用药治疗的患者占").append(maxDoseAmt).append("，使用单药治疗的患者占").append(minDoseAmt).append("；");
                            builder24FdaExplain.append("使用联用药治疗的患者占").append(maxDoseAmt).append("，使用单药治疗的患者占").append(minDoseAmt).append("；");
                        }
                    }
                    //治疗时间/不良反应发生时间
                    JSONObject time = drugAnalysis.getJSONObject("time");
                    if (CollUtil.isNotEmpty(time)) {
                        //治疗持续时间分布 durTime
                        JSONArray durTime = time.getJSONArray("durTime");
                        if (CollUtil.isNotEmpty(durTime)) {
                            String maxDurTime = durTime.getJSONObject(0).getString("name");
                            if ("unknown".equals(maxDurTime) && durTime.size() > 1) {
                                maxDurTime = durTime.getJSONObject(1).getString("name");
                            }
                            for (int i1 = 0; i1 < durTime.size(); i1++) {
                                JSONObject json = durTime.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                durTimeDataFda.put(name, inner);
                            }
                            if (StringUtils.isNotBlank(maxDurTime) && !"unknown".equals(maxDurTime)) {
                                builder22Fda.append("该药用药持续时间占比最高的是").append(maxDurTime).append("。").append("详见表 3。");
                            }
                        }
                        //不良反应时间分布 cutDtTime
                        JSONArray cutDtTime = time.getJSONArray("cutDtTime");
                        if (CollUtil.isNotEmpty(cutDtTime)) {
                            String maxDurTime = cutDtTime.getJSONObject(0).getString("name");
                            int indexCutDt = 1;
                            while ("unknown".equals(maxDurTime) || "Other".equals(maxDurTime)) {
                                maxDurTime = cutDtTime.getJSONObject(indexCutDt).getString("name");
                                indexCutDt++;
                            }
                            for (int i1 = 0; i1 < cutDtTime.size(); i1++) {
                                JSONObject json = cutDtTime.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                cutDtTimeData.put(name, inner);
                            }
                            if (StringUtils.isNotBlank(maxDurTime) && !"unknown".equals(maxDurTime) && !"Other".equals(maxDurTime)) {
                                builder24Fda.append("不良反应多发生在用药后").append(maxDurTime).append("。");
                                builder24FdaExplain.append("不良反应多发生在用药后").append(maxDurTime).append("。");
                            }
                        }
                    }
                    //适应症分布
                    JSONArray indiPt = drugAnalysis.getJSONArray("indiPt");
                    if (CollUtil.isNotEmpty(indiPt)) {
                        if (type == 1) {
                            //i+o
                            builder23Fda.append("FAERS数据库中，").append(originalI).append("致").append(originalO).append("的报告共有").append(allNum).append("例。常见的适应症有");
                            builder23FdaExplain.append("常见的适应症有");
                        } else {
                            //i
                            builder23Fda.append("FAERS数据库的").append(allNum).append("份 ADEs 报告，在已知数据中：多在");
                            builder23FdaExplain.append("多在");
                        }
                        for (int i1 = 0; i1 < indiPt.size(); i1++) {
                            List<String> inner = new ArrayList<>();
                            JSONObject ptJSONObject = indiPt.getJSONObject(i1);
                            inner.add(ptJSONObject.getString("name") + "（" + ptJSONObject.getString("englishName") + "）");
                            inner.add(ptJSONObject.getString("num"));
                            inner.add(ptJSONObject.getString("percentage"));
                            indiPtList.add(inner);
                        }
                        //取前5展示到说明中
                        /*int maxRange = Math.min(indiPtList.size(), 5);
                        for (int j = 0; j < maxRange; j++) {
                            builder23Fda.append(indiPtList.get(j).get(0)).append("，");
                        }*/
                        int num = 0;
                        for (List<String> list : indiPtList) {
                            String s = list.get(0);
                            if (s.contains("未知")) {
                                continue;
                            }
                            num++;
                            builder23Fda.append(s).append("，");
                            builder23FdaExplain.append(s).append("，");
                            if (num >= 5) {
                                break;
                            }
                        }
                        if (type == 1) {
                            //i+o
                            builder23Fda.append("。");
                            builder23FdaExplain.append("。");
                        } else {
                            //i
                            builder23Fda.append("等情况下出现了使用。");
                            builder23FdaExplain.append("等情况下出现了使用。");
                        }
                        builder23Fda.append("详见表 4。");
                    }
                }
                //不良反应及信号分析 adverseReactionSignal
                JSONObject adverseReactionSignal = fda.getJSONObject("adverseReactionSignal");
                if (CollUtil.isNotEmpty(adverseReactionSignal)) {
                    //不良反应分析 pt
                    JSONArray pt = adverseReactionSignal.getJSONArray("pt");
                    if (CollUtil.isNotEmpty(pt)) {
                        builder31Fda.append("FAERS数据库显示：在").append(originalI).append("相关的").append(allNum).append("份 ADEs 报告中，表 7列出了报告前 50 位的ADEs，包括");
                        int range = 5;
                        if (pt.size() < 5) {
                            range = pt.size();
                        }
                        Map<String, Integer> onlyMap = new HashMap<>();
                        for (int i1 = 0; i1 < pt.size(); i1++) {
                            JSONObject ptJSONObject = pt.getJSONObject(i1);
                            String englishName = ptJSONObject.getString("englishName");
                            String name = ptJSONObject.getString("name");
                            String num = ptJSONObject.getString("num");
                            String percentage = ptJSONObject.getString("percentage");
                            String diseaseType = ptJSONObject.getString("diseaseType");
                            if (onlyMap.containsKey(diseaseType)) {
                                onlyMap.put(diseaseType, onlyMap.get(diseaseType) + 1);
                            } else {
                                onlyMap.put(diseaseType, 1);
                            }
                            if (i1 < range) {
                                if (i1 == range - 2) {
                                    builder31Fda.append(name).append("和");
                                } else if (i1 == range - 1) {
                                    builder31Fda.append(name).append("等");
                                } else {
                                    builder31Fda.append(name).append("、");
                                }
                            }
                            List<String> inner = Arrays.asList(englishName, name, num, percentage);
                            ptFdaList.add(inner);
                        }
                        builder31Fda.append("，涉及");
                        int range2 = 5;
                        if (onlyMap.size() < 5) {
                            range2 = onlyMap.size();
                        }
                        int index = 0;
                        Set<Map.Entry<String, Integer>> entries = onlyMap.entrySet();
                        for (Map.Entry<String, Integer> entry : entries) {
                            if (index >= range2) {
                                break;
                            }
                            String key = entry.getKey();
                            if (index == range2 - 2) {
                                builder31Fda.append(key).append("和");
                            } else if (index == range2 - 1) {
                                builder31Fda.append(key).append("等");
                            } else {
                                builder31Fda.append(key).append("、");
                            }
                            index++;
                        }
                        builder31Fda.append("系统。");
                    }
                    //各系统器官分类的ADR信号数及ADEs报告数 signalDict
                    JSONArray signalDict = adverseReactionSignal.getJSONArray("signalDict");
                    String signalExplain = adverseReactionSignal.getString("signalDictExplain");
                    if (StringUtils.isBlank(signalExplain)) {
                        if (CollUtil.isNotEmpty(signalDict)) {
                            int signalDictTypeCount = adverseReactionSignal.getInteger("signalDictTypeCount");
                            int signalDictNumCount = adverseReactionSignal.getInteger("signalDictNumCount");
                            builder32Fda.append("FAERS数据库共获得 ").append(signalDictNumCount).append("个有信号的ADEs，共涉及").append(signalDictTypeCount).append("个SOC。使用国际医学用语词典（MedDRA）术语集系统器官分类（system organ class,SOC）对有信号的ADEs 进行分类。表 9为TOP50的信号以及信号所在的系统-器官情况。");
                            for (int i1 = 0; i1 < signalDict.size(); i1++) {
                                JSONObject dictJSONObject = signalDict.getJSONObject(i1);
                                String outEnglishName = dictJSONObject.getString("outEnglishName");
                                String englishName = dictJSONObject.getString("englishName");
                                String name = dictJSONObject.getString("name");
                                String num = dictJSONObject.getString("num");
                                String outName = dictJSONObject.getString("outName");
                                String ror = dictJSONObject.getString("ror");
                                String ebgm = dictJSONObject.getString("ebgm");
                                String ic = dictJSONObject.getString("ic");
                                //取外层key全称
                                if (!signalDictFdaOnlyMap.containsKey(outName)) {
                                    signalDictFdaOnlyMap.put(outName, outEnglishName);
                                }
                                if (signalDictFdaMap.containsKey(outName)) {
                                    List<List<String>> lists = signalDictFdaMap.get(outName);
                                    lists.add(Arrays.asList(englishName, name, num, ror, ebgm, ic));
                                } else {
                                    List<List<String>> lists = new ArrayList<>();
                                    lists.add(Arrays.asList(englishName, name, num, ror, ebgm, ic));
                                    signalDictFdaMap.put(outName, lists);
                                }
                            }
                        }
                    } else {
                        if (StringUtils.isNotEmpty(signalExplain)) {
                            signalDictExplain = signalExplain;
                        }
                    }
                    //信号图
                    JSONArray picture = adverseReactionSignal.getJSONArray("picture");
                    Boolean pictureFlag = adverseReactionSignal.getBoolean("pictureFlag");
                    if (CollUtil.isNotEmpty(picture)) {
                        if (pictureFlag) {
                            builderPicture.append("根据信号检测结果，获得 IC 值居前 ").append(picture.size()).append(" 位的信号，即");
                        }
                        StringBuilder dataName = new StringBuilder();
                        for (int i1 = 0; i1 < picture.size(); i1++) {
                            JSONObject jsonObject = picture.getJSONObject(i1);
                            String dataI = jsonObject.getString("i");
                            String dataO = jsonObject.getString("o");
                            if (pictureFlag) {
                                //i检索出来的数据
                                String ror = jsonObject.getString("ror");
                                String ic = jsonObject.getString("ic");
                                builderPicture.append(dataO).append("（ROR=").append(ror).append("，IC=").append(ic).append(") 、");
                                dataName.append(dataO).append("、");
                            } else {
                                //i+o检索出来的数据
                                builderPicture.append("为了考察这").append(dataO).append("这一信号随着时间推移的变化趋势，下图绘制了近3年").append(dataO).append("的时间扫描图谱，详见下图。");
                            }
                            //开始拼接信号图
                            JSONArray x = jsonObject.getJSONArray("x");
                            JSONArray y = jsonObject.getJSONArray("y");
                            JSONArray error = jsonObject.getJSONArray("error");
                            //确定近3年的年份并取近三年的数据
                            int index = 0;
                            List<String> yearList = new ArrayList<>();
                            for (int i2 = 0; i2 < x.size(); i2++) {
                                String strYear = x.getString(i2).substring(0, 4);
                                if (!yearList.contains(strYear)) {
                                    yearList.add(strYear);
                                }
                            }
                            yearList.sort((o1, o2) -> Integer.parseInt(o2) - Integer.parseInt(o1));
                            List<String> threeYears = new ArrayList<>();
                            int range = Integer.min(3, yearList.size());
                            for (int i2 = 0; i2 < range; i2++) {
                                threeYears.add(yearList.get(i2));
                            }
                            for (int i2 = 0; i2 < x.size(); i2++) {
                                String xString = x.getString(i2);
                                if (xString.contains(threeYears.get(threeYears.size() - 1))) {
                                    index = i2;
                                    break;
                                }
                            }
                            JSONObject inner = new JSONObject();
                            String title = "图" + (i1 + 1) + " " + threeYears.get(threeYears.size() - 1) + "-" + threeYears.get(0) + "年" + dataI + "致" + dataO + "的安全信号的时间扫描图";
                            inner.put("title", title);
                            JSONArray newX = new JSONArray();
                            JSONArray newY = new JSONArray();
                            JSONArray newError = new JSONArray();
                            for (int i2 = index; i2 < x.size(); i2++) {
                                newX.add(x.getString(i2));
                            }
                            for (int i2 = index; i2 < y.size(); i2++) {
                                newY.add(y.getString(i2));
                            }
                            for (int i2 = index; i2 < error.size(); i2++) {
                                newError.add(error.getJSONArray(i2));
                            }
                            inner.put("x", newX);
                            inner.put("y", newY);
                            inner.put("error", newError);
                            pictureArr.add(inner);
                        }
                        if (pictureFlag) {
                            builderPicture.append("。").append("为了考察这").append(picture.size()).append("个信号随着时间推移的变化趋势，绘制了近3年").append(dataName.toString(), 0, dataName.toString().length() - 1).append("安全信号的时间扫描图谱，结果见图1").append("~").append(picture.size()).append("。");
                        }
                    } else {
                        if (!pictureFlag) {
                            builderPicture.append(adverseReactionSignal.getString("signalDictExplain"));
                        }
                    }
                }
            }
            if (type != 1) {
                if (!vigi.isEmpty()) {
                    //基本情况数据
                    JSONObject basicInformation = vigi.getJSONObject("basicInformation");
                    if (CollUtil.isNotEmpty(basicInformation)) {
                        //不良反应报告总数
                        allNum = basicInformation.getInteger("allNum");
                        builder21Vigi.append("VigiAccess数据库共获得不良反应报告").append(allNum).append("例。在已知的数据中：");
                        //人群分布
                        JSONObject populationDistribution = basicInformation.getJSONObject("populationDistribution");
                        if (CollUtil.isNotEmpty(populationDistribution)) {
                            //性别
                            JSONArray reportSex = populationDistribution.getJSONArray("reportSex");
                            if (CollUtil.isNotEmpty(reportSex)) {
                                builder21Vigi.append("；");
                                String man = "0%";
                                String woman = "0%";
                                String maxSex = "";
                                int maxSexNum = Integer.MIN_VALUE;
                                for (int i1 = 0; i1 < reportSex.size(); i1++) {
                                    JSONObject json = reportSex.getJSONObject(i1);
                                    String name = json.getString("name");
                                    String num = json.getString("num");
                                    if (!"未知".equals(name)) {
                                        try {
                                            int anInt = Integer.parseInt(num);
                                            if (anInt > maxSexNum) {
                                                maxSexNum = anInt;
                                                maxSex = name;
                                            }
                                        } catch (NumberFormatException e) {
                                            e.printStackTrace();
                                        }
                                    }
                                    String percentage = json.getString("percentage");
                                    if ("男".equals(name)) {
                                        man = percentage;
                                    }
                                    if ("女".equals(name)) {
                                        woman = percentage;
                                    }
                                    JSONObject inner = new JSONObject();
                                    inner.put("name", name);
                                    inner.put("num", num);
                                    inner.put("percentage", percentage);
                                    sexDataVigi.put(name, inner);
                                }
                                builder21Vigi.append("性别构成上，男性（").append(man).append("）").append("男".equals(maxSex) ? "大于" : "小于").append("女性（").append(woman).append("）；");
                            }
                            //年龄
                            JSONArray reportAge = populationDistribution.getJSONArray("reportAge");
                            if (CollUtil.isNotEmpty(reportAge)) {
                                builder21Vigi.append("；");
                                String maxAge = "";
                                String maxPercentage = "";
                                int maxAgeNum = Integer.MIN_VALUE;
                                for (int i1 = 0; i1 < reportAge.size(); i1++) {
                                    JSONObject json = reportAge.getJSONObject(i1);
                                    String name = json.getString("name");
                                    String num = json.getString("num");
                                    String percentage = json.getString("percentage");
                                    try {
                                        int anInt = Integer.parseInt(num);
                                        if (anInt > maxAgeNum) {
                                            if (!"未知".equals(name)) {
                                                maxAgeNum = anInt;
                                                maxAge = name;
                                                maxPercentage = percentage;
                                            }
                                        }
                                    } catch (NumberFormatException e) {
                                        e.printStackTrace();
                                    }

                                    JSONObject inner = new JSONObject();
                                    inner.put("name", name);
                                    inner.put("num", num);
                                    inner.put("percentage", percentage);
                                    ageDataVigi.put(name, inner);
                                }
                                builder21Vigi.append("年龄主要集中在").append(maxAge).append("（").append(maxPercentage).append("）");
                            }
                        }
                        //报告分布
                        JSONObject reportDistribution = basicInformation.getJSONObject("reportDistribution");
                        if (CollUtil.isNotEmpty(reportDistribution)) {
                            //不良反应逐年上报情况
                            JSONArray reportYear = reportDistribution.getJSONArray("reportYear");
                            if (CollUtil.isNotEmpty(reportYear)) {
                                for (int i1 = 0; i1 < reportYear.size(); i1++) {
                                    JSONObject json = reportYear.getJSONObject(i1);
                                    String name = json.getString("name");
                                    String num = json.getString("num");
                                    String percentage = json.getString("percentage");
                                    JSONObject inner = new JSONObject();
                                    inner.put("name", name);
                                    inner.put("num", num);
                                    inner.put("percentage", percentage);
                                    reportYearDataVigi.put(name, inner);
                                }
                            }
                            //地区分布
                            JSONArray reportCountry = reportDistribution.getJSONArray("reportCountry");
                            if (CollUtil.isNotEmpty(reportCountry)) {
                                int maxIntCountry = Integer.MIN_VALUE;
                                builder21Vigi.append("；");
                                String maxCountry = "";
                                String asiaNum = "";
                                for (int i1 = 0; i1 < reportCountry.size(); i1++) {
                                    JSONObject json = reportCountry.getJSONObject(i1);
                                    String name = json.getString("name");
                                    String num = json.getString("num");
                                    if ("亚洲".equals(name)) {
                                        asiaNum = num;
                                    }
                                    try {
                                        int anInt = Integer.parseInt(num);
                                        if (!"未知".equals(maxCountry)) {
                                            if (anInt > maxIntCountry) {
                                                maxIntCountry = anInt;
                                                maxCountry = name;
                                            }
                                        }
                                    } catch (NumberFormatException e) {
                                        e.printStackTrace();
                                    }
                                    String percentage = json.getString("percentage");
                                    JSONObject inner = new JSONObject();
                                    inner.put("name", name);
                                    inner.put("num", num);
                                    inner.put("percentage", percentage);
                                    countryDataVigi.put(name, inner);
                                }
                                builder21Vigi.append(maxCountry).append("报告数最多").append("，亚洲的报告数有").append(asiaNum).append("份");
                            }
                            //职业分布
                            /*JSONArray reportOccupation = reportDistribution.getJSONArray("reportOccupation");
                            if (CollUtil.isNotEmpty(reportOccupation)) {
                                builder21Vigi.append("；");
                                String maxOccupation = reportOccupation.getJSONObject(0).getString("name");
                                if ("未知".equals(maxOccupation)){
                                    maxOccupation = reportOccupation.getJSONObject(1).getString("name");
                                }
                                for (int i1 = 0; i1 < reportOccupation.size(); i1++) {
                                    JSONObject json = reportOccupation.getJSONObject(i1);
                                    String name = json.getString("name");
                                    String num = json.getString("num");
                                    String percentage = json.getString("percentage");
                                    JSONObject inner = new JSONObject();
                                    inner.put("name", name);
                                    inner.put("num", num);
                                    inner.put("percentage", percentage);
                                    reportDataFda.put(name, inner);
                                }
                                builder21Vigi.append("上报者主要为").append(maxOccupation);
                            }*/
                        }
                    }
                    //严重不良反应分布
                    JSONObject outcomeAnalysis = vigi.getJSONObject("outcomeAnalysis");
                    if (CollUtil.isNotEmpty(outcomeAnalysis)) {
                        JSONArray adverseReactions = outcomeAnalysis.getJSONArray("adverseReactions");
                        if (CollUtil.isNotEmpty(adverseReactions)) {
                            builder21Vigi.append("；");
                            String maxOccupation = adverseReactions.getJSONObject(0).getString("name");
                            String maxNum = adverseReactions.getJSONObject(0).getString("num");
                            String maxPercentage = adverseReactions.getJSONObject(0).getString("percentage");
                            for (int i1 = 0; i1 < adverseReactions.size(); i1++) {
                                JSONObject json = adverseReactions.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                adverseReactionsDataVigi.put(name, inner);
                            }
                            builder21Vigi.append(originalI).append(" 严重不良反应结局中以").append(maxOccupation).append("报告数最多（").append(maxNum).append("例，").append(maxPercentage).append("）");
                        }
                    }
                    builder21Vigi.append("。").append("其人口学特征及严重不良事件构成情况见表 1。不良反应逐年上报情况详见表 2。");
                    //不良反应及信号分析 adverseReactionSignal
                    JSONObject adverseReactionSignal = vigi.getJSONObject("adverseReactionSignal");
                    if (CollUtil.isNotEmpty(adverseReactionSignal)) {
                        //不良反应分析 pt
                        JSONArray pt = adverseReactionSignal.getJSONArray("pt");
                        if (CollUtil.isNotEmpty(pt)) {
                            builder31Vigi.append("VigiAccess数据库显示：在").append(originalI).append("相关的").append(allNum).append("份 ADEs 报告中，表 8列出了报告前 50 位的ADEs，包括");
                            int range = 5;
                            if (pt.size() < 5) {
                                range = pt.size();
                            }
                            Map<String, Integer> onlyMap = new HashMap<>();
                            for (int i1 = 0; i1 < pt.size(); i1++) {
                                JSONObject ptJSONObject = pt.getJSONObject(i1);
                                String englishName = ptJSONObject.getString("englishName");
                                String name = ptJSONObject.getString("name");
                                String num = ptJSONObject.getString("num");
                                String percentage = ptJSONObject.getString("percentage");
                                String diseaseType = ptJSONObject.getString("diseaseType");
                                if (onlyMap.containsKey(diseaseType)) {
                                    onlyMap.put(diseaseType, onlyMap.get(diseaseType) + 1);
                                } else {
                                    onlyMap.put(diseaseType, 1);
                                }
                                if (i1 < range) {
                                    if (i1 == range - 2) {
                                        builder31Vigi.append(name).append("和");
                                    } else if (i1 == range - 1) {
                                        builder31Vigi.append(name).append("等");
                                    } else {
                                        builder31Vigi.append(name).append("、");
                                    }
                                }
                                List<String> inner = Arrays.asList(englishName, name, num, percentage);
                                ptVigiList.add(inner);
                            }
                            builder31Vigi.append("，涉及");
                            int range2 = 5;
                            if (onlyMap.size() < 5) {
                                range2 = onlyMap.size();
                            }
                            int index = 0;
                            Set<Map.Entry<String, Integer>> entries = onlyMap.entrySet();
                            for (Map.Entry<String, Integer> entry : entries) {
                                if (index >= range2) {
                                    break;
                                }
                                String key = entry.getKey();
                                if (index == range2 - 2) {
                                    builder31Vigi.append(key).append("和");
                                } else if (index == range2 - 1) {
                                    builder31Vigi.append(key).append("等");
                                } else {
                                    builder31Vigi.append(key).append("、");
                                }
                                index++;
                            }
                            builder31Vigi.append("系统。");
                        }
                        //各系统器官分类的ADR信号数及ADEs报告数 signalDict
                        JSONArray signalDict = adverseReactionSignal.getJSONArray("signalDict");
                        if (CollUtil.isNotEmpty(signalDict)) {
                            int signalDictTypeCount = adverseReactionSignal.getInteger("signalDictTypeCount");
                            int signalDictNumCount = adverseReactionSignal.getInteger("signalDictNumCount");
                            builder32Vigi.append("VigiAccess数据库共获得 ").append(signalDictNumCount).append("个有信号的ADEs，共涉及").append(signalDictTypeCount).append("个SOC。使用国际医学用语词典（MedDRA）术语集系统器官分类（system organ class,SOC）对有信号的ADEs 进行分类。表 9为TOP50的信号以及信号所在的系统-器官情况。");
                            for (int i1 = 0; i1 < signalDict.size(); i1++) {
                                JSONObject dictJSONObject = signalDict.getJSONObject(i1);
                                String outEnglishName = dictJSONObject.getString("outEnglishName");
                                String englishName = dictJSONObject.getString("englishName");
                                String name = dictJSONObject.getString("name");
                                String num = dictJSONObject.getString("num");
                                String outName = dictJSONObject.getString("outName");
                                String ror = dictJSONObject.getString("ror");
                                String ebgm = dictJSONObject.getString("ebgm");
                                String ic = dictJSONObject.getString("ic");
                                //取外层key全称
                                if (!signalDictVigiOnlyMap.containsKey(outName)) {
                                    signalDictVigiOnlyMap.put(outName, outEnglishName);
                                }
                                if (signalDictVigiMap.containsKey(outName)) {
                                    List<List<String>> lists = signalDictVigiMap.get(outName);
                                    lists.add(Arrays.asList(englishName, name, num, ror, ebgm, ic));
                                } else {
                                    List<List<String>> lists = new ArrayList<>();
                                    lists.add(Arrays.asList(englishName, name, num, ror, ebgm, ic));
                                    signalDictVigiMap.put(outName, lists);
                                }
                            }
                        }
                    }
                }
            }
        }

        //一、循证方法
        Paragraph title1 = createHead(14, "一、循证方法", Element.ALIGN_LEFT);
        document.add(title1);
        //1.1 检索策略
        Paragraph title11 = createHead(14, "1.1 检索策略", Element.ALIGN_LEFT);
        document.add(title11);
        //添加正文
        if (StringUtils.isNotEmpty(originalI)) {
            if (!originalI.equals(i)) {
                Paragraph paragraphData1 = createData("药品名称: " + originalI + "/" + i);
                paragraphData1.setFirstLineIndent(25);
                document.add(paragraphData1);
            } else {
                Paragraph paragraphData1 = createData("药品名称: " + originalI);
                paragraphData1.setFirstLineIndent(25);
                document.add(paragraphData1);
            }
        }
        if (StringUtils.isNotEmpty(originalO)) {
            if (!originalO.equals(o)) {
                Paragraph paragraphData2 = createData("不良反应: " + originalO + "/" + o);
                paragraphData2.setFirstLineIndent(25);
                document.add(paragraphData2);
            } else {
                Paragraph paragraphData2 = createData("不良反应: " + originalO);
                paragraphData2.setFirstLineIndent(25);
                document.add(paragraphData2);
            }
        }
        Paragraph paragraphData3 = createData("检索范围: FAERS不良反应数据库、VigiAccess数据库");
        paragraphData3.setFirstLineIndent(25);
        document.add(paragraphData3);
        Paragraph paragraphData4 = createData("检索时间: 建库时间--2022.09.14");
        paragraphData4.setFirstLineIndent(25);
        document.add(paragraphData4);
        Paragraph paragraphData5 = createData("方法学内容详见附录。");
        paragraphData5.setFirstLineIndent(25);
        document.add(paragraphData5);

        //二、循证结果
        Paragraph title2 = createHead(14, "二、循证结果", Element.ALIGN_LEFT);
        title2.setSpacingAfter(10);
        title2.setSpacingBefore(10);
        document.add(title2);

        //分析综述
        Paragraph mainData = createData("基于您的检索词：" + conditionData);
        mainData.setFirstLineIndent(25);
        document.add(mainData);
        if (!analysisOverview.isEmpty()) {
            JSONArray analysisList = analysisOverview.getJSONArray("list");
            if (CollUtil.isNotEmpty(analysisList)) {
                for (int i1 = 0; i1 < analysisList.size(); i1++) {
                    String string = analysisList.getString(i1);
                    //对获得的分析综述进行处理
                    if (string.contains("基于您的检索词")) {
                        continue;
                    }
                    //去除span标签
                    //string = string.replaceAll("<span>", "").replaceAll("</span>", "");
                    Paragraph inner = createData(string);
                    inner.setFirstLineIndent(25);
                    document.add(inner);
                }
            }
        }

        //2.1 基本情况
        Paragraph title21 = createHead(14, "2 .1  基本情况", Element.ALIGN_LEFT);
        title21.setSpacingAfter(10);
        title21.setSpacingBefore(10);
        document.add(title21);
        //开始合并基础数据
        int flagFda211 = 0;
        int flagVigi211 = 0;
        //性别
        List<List<String>> sexList = new ArrayList<>();
        //年龄
        List<List<String>> ageList = new ArrayList<>();
        //报告国家
        List<List<String>> countryList = new ArrayList<>();
        //职业
        List<List<String>> reportList = new ArrayList<>();
        //不良反应逐年上报情况
        List<List<String>> reportYear = new ArrayList<>();
        //严重不良反应
        List<List<String>> adverseReactionsList = new ArrayList<>();
        //表1列数
        int tableNum1 = 0;
        if (CollUtil.isNotEmpty(sexDataFda) || CollUtil.isNotEmpty(ageDataFda) || CollUtil.isNotEmpty(countryDataFda) || CollUtil.isNotEmpty(reportDataFda)) {
            flagFda211 = 1;
        }
        if (CollUtil.isNotEmpty(sexDataVigi) || CollUtil.isNotEmpty(ageDataVigi) || CollUtil.isNotEmpty(countryDataVigi)) {
            flagVigi211 = 1;
        }
        if (flagFda211 == 1 && flagVigi211 == 1) {
            tableNum1 = 5;
            //性别
            if (CollUtil.isNotEmpty(sexDataFda) && CollUtil.isNotEmpty(sexDataVigi)) {
                Set<String> keySet = new HashSet<>();
                Set<String> fdaSet = sexDataFda.keySet();
                Set<String> vigiSet = sexDataVigi.keySet();
                keySet.addAll(fdaSet);
                keySet.addAll(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = sexDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    //vigi
                    JSONObject vigiJSONObject = sexDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    sexList.add(inner);
                }
            }
            //年龄
            if (CollUtil.isNotEmpty(ageDataFda) && CollUtil.isNotEmpty(ageDataVigi)) {
                Set<String> keySet = new HashSet<>();
                Set<String> fdaSet = ageDataFda.keySet();
                Set<String> vigiSet = ageDataVigi.keySet();
                keySet.addAll(fdaSet);
                keySet.addAll(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = ageDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    //vigi
                    JSONObject vigiJSONObject = ageDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    ageList.add(inner);
                }
            }
            //报告国家
            if (CollUtil.isNotEmpty(countryDataFda) && CollUtil.isNotEmpty(countryDataVigi)) {
                Set<String> keySet = new HashSet<>();
                Set<String> fdaSet = countryDataFda.keySet();
                Set<String> vigiSet = countryDataVigi.keySet();
                keySet.addAll(fdaSet);
                keySet.addAll(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = countryDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    //vigi
                    JSONObject vigiJSONObject = countryDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    countryList.add(inner);
                }
            }
            //职业
            if (CollUtil.isNotEmpty(reportDataFda)) {
                Set<String> fdaSet = reportDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = reportDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    //vigi
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    reportList.add(inner);
                }
            }
            //严重不良反应
            if (CollUtil.isNotEmpty(adverseReactionsDataFda) || CollUtil.isNotEmpty(adverseReactionsDataVigi)) {
                Set<String> keySet = new HashSet<>();
                Set<String> fdaSet = adverseReactionsDataFda.keySet();
                Set<String> vigiSet = adverseReactionsDataVigi.keySet();
                keySet.addAll(fdaSet);
                keySet.addAll(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = adverseReactionsDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    //vigi
                    JSONObject vigiJSONObject = adverseReactionsDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    adverseReactionsList.add(inner);
                }
            }
        } else if (flagFda211 == 1) {
            tableNum1 = 3;
            //性别
            if (CollUtil.isNotEmpty(sexDataFda)) {
                Set<String> fdaSet = sexDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = sexDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    sexList.add(inner);
                }
            }
            //年龄
            if (CollUtil.isNotEmpty(ageDataFda)) {
                Set<String> fdaSet = ageDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = ageDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    ageList.add(inner);
                }
            }
            //报告国家
            if (CollUtil.isNotEmpty(countryDataFda)) {
                Set<String> fdaSet = countryDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = countryDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    countryList.add(inner);
                }
            }
            //职业
            if (CollUtil.isNotEmpty(reportDataFda)) {
                Set<String> fdaSet = reportDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = reportDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    reportList.add(inner);
                }
            }
            //严重不良反应
            if (CollUtil.isNotEmpty(adverseReactionsDataFda)) {
                Set<String> fdaSet = adverseReactionsDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = adverseReactionsDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    adverseReactionsList.add(inner);
                }
            }
        } else if (flagVigi211 == 1) {
            tableNum1 = 3;
            //性别
            if (CollUtil.isNotEmpty(sexDataVigi)) {
                Set<String> vigiSet = sexDataVigi.keySet();
                Set<String> keySet = new HashSet<>(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //vigi
                    JSONObject vigiJSONObject = sexDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    sexList.add(inner);
                }
            }
            //年龄
            if (CollUtil.isNotEmpty(ageDataVigi)) {
                Set<String> vigiSet = ageDataVigi.keySet();
                Set<String> keySet = new HashSet<>(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //vigi
                    JSONObject vigiJSONObject = ageDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    ageList.add(inner);
                }
            }
            //报告国家
            if (CollUtil.isNotEmpty(countryDataVigi)) {
                Set<String> vigiSet = countryDataVigi.keySet();
                Set<String> keySet = new HashSet<>(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //vigi
                    JSONObject vigiJSONObject = countryDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    countryList.add(inner);
                }
            }
            //严重不良反应
            if (CollUtil.isNotEmpty(adverseReactionsDataVigi)) {
                Set<String> vigiSet = adverseReactionsDataVigi.keySet();
                Set<String> keySet = new HashSet<>(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //vigi
                    JSONObject vigiJSONObject = adverseReactionsDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    adverseReactionsList.add(inner);
                }
            }
        }

        //表2列数
        int tableNum2;
        int flagFda212 = 0;
        int flagVigi212 = 0;
        if (CollUtil.isNotEmpty(reportYearDataFda)) {
            flagFda212 = 1;
        }
        if (CollUtil.isNotEmpty(reportYearDataVigi)) {
            flagVigi212 = 1;
        }
        if (flagFda212 == 1 && flagVigi212 == 1) {
            tableNum2 = 3;
            Set<String> keySet = new HashSet<>();
            Set<String> fdaSet = reportYearDataFda.keySet();
            Set<String> vigiSet = reportYearDataVigi.keySet();
            keySet.addAll(fdaSet);
            keySet.addAll(vigiSet);
            List<String> keyList = new ArrayList<>(keySet);
            Collections.sort(keyList);
            for (String s : keyList) {
                List<String> inner = new ArrayList<>();
                inner.add(s);
                //fda
                JSONObject fdaJSONObject = reportYearDataFda.getJSONObject(s);
                String fdaNum = "-";
                //String fdaPercentage = "-";
                if (CollUtil.isNotEmpty(fdaJSONObject)) {
                    fdaNum = fdaJSONObject.getString("num");
                    //fdaPercentage = fdaJSONObject.getString("percentage");
                }
                inner.add(fdaNum);
                //inner.add(fdaPercentage);
                //vigi
                JSONObject vigiJSONObject = reportYearDataVigi.getJSONObject(s);
                String vigiNum = "-";
                //String vigiPercentage = "-";
                if (CollUtil.isNotEmpty(vigiJSONObject)) {
                    vigiNum = vigiJSONObject.getString("num");
                    //vigiPercentage = vigiJSONObject.getString("percentage");
                }
                inner.add(vigiNum);
                //inner.add(vigiPercentage);
                reportYear.add(inner);
            }
        } else if (flagFda212 == 1) {
            tableNum2 = 2;
            Set<String> fdaSet = reportYearDataFda.keySet();
            Set<String> keySet = new HashSet<>(fdaSet);
            List<String> keyList = new ArrayList<>(keySet);
            Collections.sort(keyList);
            for (String s : keyList) {
                List<String> inner = new ArrayList<>();
                inner.add(s);
                //fda
                JSONObject fdaJSONObject = reportYearDataFda.getJSONObject(s);
                String fdaNum = "-";
                //String fdaPercentage = "-";
                if (CollUtil.isNotEmpty(fdaJSONObject)) {
                    fdaNum = fdaJSONObject.getString("num");
                    //fdaPercentage = fdaJSONObject.getString("percentage");
                }
                inner.add(fdaNum);
                //inner.add(fdaPercentage);
                reportYear.add(inner);
            }
        } else {
            tableNum2 = 2;
            Set<String> vigiSet = reportYearDataVigi.keySet();
            Set<String> keySet = new HashSet<>(vigiSet);
            List<String> keyList = new ArrayList<>(keySet);
            Collections.sort(keyList);
            for (String s : keyList) {
                List<String> inner = new ArrayList<>();
                inner.add(s);
                //vigi
                JSONObject vigiJSONObject = reportYearDataVigi.getJSONObject(s);
                String vigiNum = "-";
                //String vigiPercentage = "-";
                if (CollUtil.isNotEmpty(vigiJSONObject)) {
                    vigiNum = vigiJSONObject.getString("num");
                    // vigiPercentage = vigiJSONObject.getString("percentage");
                }
                inner.add(vigiNum);
                //inner.add(vigiPercentage);
                reportYear.add(inner);
            }
        }

        //***************创建表格1***********************
        PdfPTable table1 = new PdfPTable(tableNum1);
        table1.setTotalWidth(PageSize.A4.getWidth() - 100);
        table1.setLockedWidth(true);
        List<String> nameList1;
        if (flagFda211 == 1 && flagVigi211 == 1) {
            //2.1 fda说明
            String replaceAll1 = builder21Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph data1 = createData(replaceAll1);
            data1.setFirstLineIndent(25);
            document.add(data1);

            String replaceAll2 = builder21Vigi.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph data2 = createData(replaceAll2);
            data2.setFirstLineIndent(25);
            document.add(data2);

            nameList1 = Arrays.asList("信息/类别", "FAERS数据库", "VigiAccess数据库", "报告例数", "构成比", "报告例数", "构成比");
        } else if (flagFda211 == 1) {
            String replaceAll1 = builder21Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph data1 = createData(replaceAll1);
            data1.setFirstLineIndent(25);
            document.add(data1);

            nameList1 = Arrays.asList("信息/类别", "FAERS数据库", "报告例数", "占比");
        } else {
            //2.1 vigi说明
            String replaceAll2 = builder21Vigi.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph data2 = createData(replaceAll2);
            data2.setFirstLineIndent(25);
            document.add(data2);

            nameList1 = Arrays.asList("信息/类别", "VigiAccess数据库", "报告例数", "占比");
        }
        Paragraph paragraphTable1Head;
        //开始创建表
        if (type == 1) {
            paragraphTable1Head = createHead(14, "表1  " + originalI + "致" + originalO + "的人口学特征及严重不良事件构成情况", Element.ALIGN_CENTER);
        } else {
            paragraphTable1Head = createHead(14, "表1  " + originalI + "的人口学特征及严重不良事件构成情况", Element.ALIGN_CENTER);
        }
        //设置段落前后间距
        paragraphTable1Head.setSpacingAfter(10);
        paragraphTable1Head.setSpacingBefore(10);
        document.add(paragraphTable1Head);
        //table1设置表格标题
        Font font = createFont(14, Font.NORMAL);
        for (String s : nameList1) {
            PdfPCell cell = new PdfPCell(new Phrase(s, font));
            if ("信息/类别".equals(s)) {
                cell.setRowspan(2);
            }
            if ("FAERS数据库".equals(s) || "VigiAccess数据库".equals(s)) {
                cell.setColspan(2);
            }
            cell.setBackgroundColor(new BaseColor(221, 221, 221));
            cell.setMinimumHeight(20);
            cell.setUseAscender(true);
            cell.setHorizontalAlignment(Element.ALIGN_CENTER);
            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
            table1.addCell(cell);
        }
        //table1设置表格内容
        //性别 + 年龄段/岁 + 报告国家 + 上报者职业 + 严重不良事件
        Map<String, List<List<String>>> dataMap1 = new LinkedHashMap<>();
        if (CollUtil.isNotEmpty(sexList)) {
            dataMap1.put("性别", sexList);
        }
        if (CollUtil.isNotEmpty(ageList)) {
            dataMap1.put("年龄段/岁", ageList);
        }
        if (CollUtil.isNotEmpty(countryList)) {
            dataMap1.put("报告国家", countryList);
        }
        if (CollUtil.isNotEmpty(reportList)) {
            dataMap1.put("上报者职业", reportList);
        }
        if (CollUtil.isNotEmpty(adverseReactionsList)) {
            dataMap1.put("严重不良事件", adverseReactionsList);
        }
        //标题加粗
        Font fontTitle = createFont(14, Font.BOLD);
        Set<Map.Entry<String, List<List<String>>>> entries1 = dataMap1.entrySet();
        for (Map.Entry<String, List<List<String>>> entry : entries1) {
            String key = entry.getKey();
            List<List<String>> value = entry.getValue();
            PdfPCell cell = new PdfPCell(new Phrase(key, fontTitle));
            cell.setMinimumHeight(20);
            cell.setUseAscender(true);
            cell.setHorizontalAlignment(Element.ALIGN_LEFT);
            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
            table1.addCell(cell);
            PdfPCell cellSpace = new PdfPCell(new Phrase("", font));
            for (int i1 = 0; i1 < tableNum1 - 1; i1++) {
                table1.addCell(cellSpace);
            }
            for (List<String> list : value) {
                for (String s : list) {
                    table1.addCell(createTableContent(s));
                }
            }
        }
        document.add(table1);

        //****************创建表格2*********************
        PdfPTable table2 = new PdfPTable(tableNum2);
        table1.setTotalWidth(PageSize.A4.getWidth() - 100);
        table1.setLockedWidth(true);
        List<String> nameList2;
        if (flagFda211 == 1 && flagVigi211 == 1) {
            nameList2 = Arrays.asList("年份", "不良反应报告数量（份）", "FAERS数据库", "VigiAccess数据库");
        } else if (flagFda211 == 1) {
            nameList2 = Arrays.asList("年份", "不良反应报告数量（份）", "FAERS数据库");
        } else {
            nameList2 = Arrays.asList("年份", "不良反应报告数量（份）", "VigiAccess数据库");
        }
        Paragraph paragraphTable2Head;
        //开始创建表
        if (type == 1) {
            paragraphTable2Head = createHead(14, "表2  不良反应逐年上报情况", Element.ALIGN_CENTER);
        } else {
            paragraphTable2Head = createHead(14, "表2  不良反应逐年上报情况", Element.ALIGN_CENTER);
        }
        //设置段落前后间距
        paragraphTable2Head.setSpacingAfter(10);
        paragraphTable2Head.setSpacingBefore(10);
        document.add(paragraphTable2Head);
        //table2设置表格标题
        for (String s : nameList2) {
            PdfPCell cell = new PdfPCell(new Phrase(s, font));
            if ("年份".equals(s)) {
                cell.setRowspan(2);
            }
            if (flagFda212 == 1 && flagVigi212 == 1 && "不良反应报告数量（份）".equals(s)) {
                cell.setColspan(2);
            }
            cell.setBackgroundColor(new BaseColor(221, 221, 221));
            cell.setMinimumHeight(20);
            cell.setUseAscender(true);
            cell.setHorizontalAlignment(Element.ALIGN_CENTER);
            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
            table2.addCell(cell);
        }
        //table2设置表格内容
        for (List<String> list : reportYear) {
            for (String s : list) {
                table2.addCell(createTableContent(s));
            }
        }
        document.add(table2);


        //2.2 用药情况分析
        Paragraph title22 = createHead(14, "2 .2  用药情况分析", Element.ALIGN_LEFT);
        title22.setSpacingAfter(10);
        title22.setSpacingBefore(10);
        document.add(title22);

        //剂型
        List<List<String>> doseFormList = new ArrayList<>();
        //给药途径
        List<List<String>> routeList = new ArrayList<>();
        //给药剂量
        List<List<String>> doseAmtList = new ArrayList<>();
        //持续用药时间
        List<List<String>> durTimeList = new ArrayList<>();
        //表3列数
        int tableNum3 = 3;
        //数据处理
        if (CollUtil.isNotEmpty(doseFormDataFda) || CollUtil.isNotEmpty(routeDataFda) || CollUtil.isNotEmpty(doseAmtDataFda) || CollUtil.isNotEmpty(durTimeDataFda)) {
            //剂型
            if (CollUtil.isNotEmpty(doseFormDataFda)) {
                Set<String> keySet = new HashSet<>(doseFormDataFda.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = doseFormDataFda.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    doseFormList.add(inner);
                }
            }
            //给药途径
            if (CollUtil.isNotEmpty(routeDataFda)) {
                Set<String> keySet = new HashSet<>(routeDataFda.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = routeDataFda.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    routeList.add(inner);
                }
            }
            //给药剂量
            if (CollUtil.isNotEmpty(doseAmtDataFda)) {
                Set<String> keySet = new HashSet<>(doseAmtDataFda.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = doseAmtDataFda.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    doseAmtList.add(inner);
                }
            }
            //持续用药时间
            if (CollUtil.isNotEmpty(durTimeDataFda)) {
                Set<String> keySet = new HashSet<>(durTimeDataFda.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = durTimeDataFda.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    durTimeList.add(inner);
                }
            }

            //2.2说明
            String replaceAll22 = builder22Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph data22 = createData(replaceAll22);
            data22.setFirstLineIndent(25);
            document.add(data22);
            //***************创建表格3***********************
            PdfPTable table3 = new PdfPTable(tableNum3);
            table3.setTotalWidth(PageSize.A4.getWidth() - 100);
            table3.setLockedWidth(true);
            //开始创建表
            Paragraph paragraphTable22Head;
            if (type == 1) {
                paragraphTable22Head = createHead(14, "表3  用药情况", Element.ALIGN_CENTER);
            } else {
                paragraphTable22Head = createHead(14, "表3  用药情况", Element.ALIGN_CENTER);
            }
            //设置段落前后间距
            paragraphTable22Head.setSpacingAfter(10);
            paragraphTable22Head.setSpacingBefore(10);
            document.add(paragraphTable22Head);
            //开始创建table3表头
            List<String> nameList3 = Arrays.asList("影响因素", "报告例数", "占比");
            for (String s : nameList3) {
                PdfPCell cell = new PdfPCell(new Phrase(s, font));
                cell.setBackgroundColor(new BaseColor(221, 221, 221));
                cell.setMinimumHeight(20);
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table3.addCell(cell);
            }
            //table3设置表格内容
            //剂型 + 给药途径 + 给药剂量 + 持续用药时间
            Map<String, List<List<String>>> dataMap3 = new LinkedHashMap<>();
            if (CollUtil.isNotEmpty(doseFormList)) {
                dataMap3.put("剂型", doseFormList);
            }
            if (CollUtil.isNotEmpty(routeList)) {
                dataMap3.put("给药途径", routeList);
            }
            if (CollUtil.isNotEmpty(doseAmtList)) {
                dataMap3.put("给药剂量", doseAmtList);
            }
            if (CollUtil.isNotEmpty(durTimeList)) {
                dataMap3.put("持续用药时间", durTimeList);
            }
            Set<Map.Entry<String, List<List<String>>>> entries3 = dataMap3.entrySet();
            for (Map.Entry<String, List<List<String>>> entry : entries3) {
                String key = entry.getKey();
                List<List<String>> value = entry.getValue();
                PdfPCell cell = new PdfPCell(new Phrase(key, fontTitle));
                cell.setMinimumHeight(20);
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_LEFT);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table3.addCell(cell);
                PdfPCell cellSpace = new PdfPCell(new Phrase("", font));
                for (int i1 = 0; i1 < tableNum3 - 1; i1++) {
                    table3.addCell(cellSpace);
                }
                for (List<String> list : value) {
                    for (String s : list) {
                        table3.addCell(createTableContent(s));
                    }
                }
            }
            document.add(table3);
            Paragraph tableTitle = createDataType(10, "注释：持续用药时间=结束用药时间-开始用药时间", Font.NORMAL);
            document.add(tableTitle);
        }

        //2.3 用药适应征分析
        Paragraph title23 = createHead(14, "2 .3  用药适应征分析", Element.ALIGN_LEFT);
        title23.setSpacingAfter(10);
        title23.setSpacingBefore(10);
        document.add(title23);
        if (CollUtil.isNotEmpty(indiPtList)) {
            //2.3 用药适应征分析说明
            String replaceAll23 = builder23Fda.toString().replaceAll("，。", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph data23 = createData(replaceAll23);
            data23.setFirstLineIndent(25);
            document.add(data23);
            //开始创建表4
            PdfPTable table4 = new PdfPTable(3);
            table4.setTotalWidth(PageSize.A4.getWidth() - 100);
            table4.setLockedWidth(true);
            Paragraph paragraphTable4Head = createHead(14, "表4  用药适应症分布情况", Element.ALIGN_CENTER);
            //设置段落前后间距
            paragraphTable4Head.setSpacingAfter(10);
            paragraphTable4Head.setSpacingBefore(10);
            document.add(paragraphTable4Head);
            //table4设置表格标题
            List<String> nameList4 = Arrays.asList("用药适应症", "例数", "占比");
            for (String s : nameList4) {
                PdfPCell cell = new PdfPCell(new Phrase(s, font));
                cell.setBackgroundColor(new BaseColor(221, 221, 221));
                cell.setMinimumHeight(20);
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table4.addCell(cell);
            }
            for (List<String> list : indiPtList) {
                for (String s : list) {
                    table4.addCell(createTableContent(s));
                }
            }
            document.add(table4);
        }

        //2.4 给药方案及不良反应发生时间分布
        Paragraph title24 = createHead(14, "2 .4  给药方案及不良反应发生时间分布", Element.ALIGN_LEFT);
        title24.setSpacingAfter(10);
        title24.setSpacingBefore(10);
        document.add(title24);
        if (CollUtil.isNotEmpty(drugNumData) || CollUtil.isNotEmpty(cutDtTimeData)) {
            String replaceAll24 = builder24Fda.append("详见表 5。").toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph data24 = createData(replaceAll24);
            data24.setFirstLineIndent(25);
            document.add(data24);
            //给药方案
            List<List<String>> drugNumList = new ArrayList<>();
            if (CollUtil.isNotEmpty(drugNumData)) {
                Set<String> keySet = new HashSet<>(drugNumData.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = drugNumData.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    drugNumList.add(inner);
                }
            }
            //不良反应发生时间
            List<List<String>> cutDtTimeList = new ArrayList<>();
            if (CollUtil.isNotEmpty(cutDtTimeData)) {
                Set<String> keySet = new HashSet<>(cutDtTimeData.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = cutDtTimeData.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    cutDtTimeList.add(inner);
                }
            }
            //***************创建表格5***********************
            PdfPTable table5 = new PdfPTable(3);
            table5.setTotalWidth(PageSize.A4.getWidth() - 100);
            table5.setLockedWidth(true);
            //开始创建表
            Paragraph paragraphTable24Head = createHead(14, "表5  给药方案、不良反应发生时间分布", Element.ALIGN_CENTER);
            //设置段落前后间距
            paragraphTable24Head.setSpacingAfter(10);
            paragraphTable24Head.setSpacingBefore(10);
            document.add(paragraphTable24Head);
            //开始创建table3表头
            List<String> nameList3 = Arrays.asList("影响因素", "报告例数", "占比");
            for (String s : nameList3) {
                PdfPCell cell = new PdfPCell(new Phrase(s, font));
                cell.setBackgroundColor(new BaseColor(221, 221, 221));
                cell.setMinimumHeight(20);
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table5.addCell(cell);
            }
            //table3设置表格内容
            //给药方案 + 不良反应发生时间
            Map<String, List<List<String>>> dataMap5 = new LinkedHashMap<>();
            if (CollUtil.isNotEmpty(drugNumList)) {
                dataMap5.put("给药方案", drugNumList);
            }
            if (CollUtil.isNotEmpty(cutDtTimeList)) {
                dataMap5.put("不良反应发生时间", cutDtTimeList);
            }
            Set<Map.Entry<String, List<List<String>>>> entries5 = dataMap5.entrySet();
            for (Map.Entry<String, List<List<String>>> entry : entries5) {
                String key = entry.getKey();
                List<List<String>> value = entry.getValue();
                PdfPCell cell = new PdfPCell(new Phrase(key, fontTitle));
                cell.setMinimumHeight(20);
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_LEFT);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table5.addCell(cell);
                PdfPCell cellSpace = new PdfPCell(new Phrase("", font));
                for (int i1 = 0; i1 < 2; i1++) {
                    table5.addCell(cellSpace);
                }
                for (List<String> list : value) {
                    for (String s : list) {
                        table5.addCell(createTableContent(s));
                    }
                }
            }
            document.add(table5);
            Paragraph tableTitle = createDataType(10, "注释：不良反应发生时间：用药后首次出现不良反应的时间段。", Font.NORMAL);
            document.add(tableTitle);
        }

        //2.5 治疗与转归
        Paragraph title25 = createHead(14, "2 .5  治疗与转归", Element.ALIGN_LEFT);
        title25.setSpacingAfter(10);
        title25.setSpacingBefore(10);
        document.add(title25);
        if (CollUtil.isNotEmpty(dechalAndRechalMap)) {
            String replaceAll25 = builder25Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph data25 = createData(replaceAll25);
            data25.setFirstLineIndent(25);
            document.add(data25);
            //治疗与转归
            //开始创建表6
            PdfPTable table6 = new PdfPTable(4);
            table6.setTotalWidth(PageSize.A4.getWidth() - 100);
            table6.setLockedWidth(true);
            Paragraph paragraphTable6Head = createHead(14, "表6 治疗与转归", Element.ALIGN_CENTER);
            //设置段落前后间距
            paragraphTable6Head.setSpacingAfter(10);
            paragraphTable6Head.setSpacingBefore(10);
            document.add(paragraphTable6Head);
            //table6设置表格标题
            List<String> nameList6 = Arrays.asList("治疗与转归", "结果", "例数", "占比");
            for (String s : nameList6) {
                PdfPCell cell = new PdfPCell(new Phrase(s, font));
                cell.setBackgroundColor(new BaseColor(221, 221, 221));
                cell.setMinimumHeight(20);
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table6.addCell(cell);
            }
            Set<Map.Entry<String, List<List<String>>>> entries = dechalAndRechalMap.entrySet();
            for (Map.Entry<String, List<List<String>>> entry : entries) {
                String key = entry.getKey();
                List<List<String>> value = entry.getValue();
                PdfPCell name = createTableContent(key);
                name.setRowspan(value.size());
                table6.addCell(name);
                for (List<String> list : value) {
                    for (String s : list) {
                        table6.addCell(createTableContent(s));
                    }
                }
            }
            document.add(table6);
        }

        //三、信号检测
        Paragraph title3 = createHead(14, "三、 信号检测", Element.ALIGN_LEFT);
        title3.setSpacingAfter(10);
        title3.setSpacingBefore(10);
        document.add(title3);
        //三模块可以隐藏，动态设置标题
        int moduleTrendsTitleNum = 1;
        if (CollUtil.isNotEmpty(ptFdaList) || CollUtil.isNotEmpty(ptVigiList)) {
            //3.1 不良反应分析结果
            Paragraph title31 = createHead(14, "3 ." + moduleTrendsTitleNum + "  不良反应分析结果", Element.ALIGN_LEFT);
            title31.setSpacingAfter(10);
            title31.setSpacingBefore(10);
            document.add(title31);
            moduleTrendsTitleNum++;
            List<String> nameList78 = Arrays.asList("首选术语（PT）", "不良事件", "报告例数/例", "比例/%");
            if (CollUtil.isNotEmpty(ptFdaList)) {
                //3.1 fda说明
                String replaceAll31 = builder31Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；").replaceAll("、、", "、");
                Paragraph data31 = createData(replaceAll31);
                data31.setFirstLineIndent(25);
                document.add(data31);
            }
            if (CollUtil.isNotEmpty(ptVigiList)) {
                //3.1 vigi说明
                String replaceAll31 = builder31Vigi.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；").replaceAll("、、", "、");
                ;
                Paragraph data31 = createData(replaceAll31);
                data31.setFirstLineIndent(25);
                document.add(data31);
            }
            if (CollUtil.isNotEmpty(ptFdaList)) {
                //***************创建表格7**************表7 FAERS数据库中atorvastatin 发生频次排序（TOP 20）*********
                Paragraph paragraphTable7Head = createHead(14, "表7  FAERS数据库中" + originalI + " 发生频次排序（TOP 50）", Element.ALIGN_CENTER);
                //设置段落前后间距
                paragraphTable7Head.setSpacingAfter(10);
                paragraphTable7Head.setSpacingBefore(10);
                document.add(paragraphTable7Head);
                //表7
                PdfPTable table7 = new PdfPTable(4);
                table7.setTotalWidth(PageSize.A4.getWidth() - 100);
                table7.setLockedWidth(true);
                for (String s : nameList78) {
                    PdfPCell cell = new PdfPCell(new Phrase(s, font));
                    cell.setBackgroundColor(new BaseColor(221, 221, 221));
                    cell.setMinimumHeight(20);
                    cell.setUseAscender(true);
                    cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                    cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    table7.addCell(cell);
                }
                //设置表7内容
                for (List<String> list : ptFdaList) {
                    for (String s : list) {
                        table7.addCell(createTableContent(s));
                    }
                }
                document.add(table7);
            }
            if (CollUtil.isNotEmpty(ptVigiList)) {
                //***************创建表格8**************表8 VigiAccess数据库中atorvastatin发生频次排序（TOP 20） *********
                Paragraph paragraphTable8Head = createHead(14, "表8  VigiAccess数据库中" + originalI + "发生频次排序（TOP 50） ", Element.ALIGN_CENTER);
                //设置段落前后间距
                paragraphTable8Head.setSpacingAfter(10);
                paragraphTable8Head.setSpacingBefore(10);
                document.add(paragraphTable8Head);
                //表7
                PdfPTable table8 = new PdfPTable(4);
                table8.setTotalWidth(PageSize.A4.getWidth() - 100);
                table8.setLockedWidth(true);
                for (String s : nameList78) {
                    PdfPCell cell = new PdfPCell(new Phrase(s, font));
                    cell.setBackgroundColor(new BaseColor(221, 221, 221));
                    cell.setMinimumHeight(20);
                    cell.setUseAscender(true);
                    cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                    cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    table8.addCell(cell);
                }
                //设置表8内容
                for (List<String> list : ptVigiList) {
                    for (String s : list) {
                        table8.addCell(createTableContent(s));
                    }
                }
                document.add(table8);
            }
        }

        //3.2 各系统器官分类的ADR信号数及ADEs报告数
        Paragraph title32 = createHead(14, "3 ." + moduleTrendsTitleNum + "  各系统器官分类的ADR信号数及ADEs报告数", Element.ALIGN_LEFT);
        title32.setSpacingAfter(10);
        title32.setSpacingBefore(10);
        document.add(title32);
        moduleTrendsTitleNum++;
        List<String> nameList910 = Arrays.asList("SOC分类/首选术语（PT）", "不良事件", "报告数/例", "ROR值", "EBGM值", "IC值");
        if (CollUtil.isNotEmpty(signalDictFdaMap) && CollUtil.isNotEmpty(signalDictVigiMap)) {
            //3.2 fda说明
            String replaceFda32 = builder32Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph dataFda32 = createData(replaceFda32);
            dataFda32.setFirstLineIndent(25);
            document.add(dataFda32);
        }
        if (CollUtil.isNotEmpty(signalDictVigiMap)) {
            //3.2 vig说明
            String replaceVigi32 = builder32Vigi.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph dataVigi32 = createData(replaceVigi32);
            dataVigi32.setFirstLineIndent(25);
            document.add(dataVigi32);
        }
        if (CollUtil.isNotEmpty(signalDictFdaMap)) {
            //***************创建表格9**************FAERS数据库 ADEs 信号检测表（TOP 50）*********
            Paragraph paragraphTable9Head = createHead(14, "表9  FAERS数据库 ADEs 信号检测表（TOP 50）", Element.ALIGN_CENTER);
            //设置段落前后间距
            paragraphTable9Head.setSpacingAfter(10);
            paragraphTable9Head.setSpacingBefore(10);
            document.add(paragraphTable9Head);
            //表9
            PdfPTable table9 = new PdfPTable(6);
            table9.setTotalWidth(PageSize.A4.getWidth() - 100);
            table9.setLockedWidth(true);
            for (String s : nameList910) {
                PdfPCell cell = new PdfPCell(new Phrase(s, font));
                cell.setBackgroundColor(new BaseColor(221, 221, 221));
                cell.setMinimumHeight(20);
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table9.addCell(cell);
            }
            //设置表9内容
            Set<String> keySet = signalDictFdaMap.keySet();
            for (String key : keySet) {
                List<List<String>> lists = signalDictFdaMap.get(key);
                PdfPCell cell = new PdfPCell(new Phrase(signalDictFdaOnlyMap.get(key), fontTitle));
                cell.setMinimumHeight(20);
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_LEFT);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table9.addCell(cell);
                PdfPCell cellSpace = new PdfPCell(new Phrase("", font));
                for (int i1 = 0; i1 < 5; i1++) {
                    table9.addCell(cellSpace);
                }
                for (List<String> list : lists) {
                    for (String s : list) {
                        table9.addCell(createTableContent(s));
                    }
                }
            }
            document.add(table9);
        }
        if (CollUtil.isNotEmpty(signalDictVigiMap)) {
            //***************创建表格10**************表10  VigiAccess数据库 ADEs 信号检测表（TOP 10））*********
            Paragraph paragraphTable10Head = createHead(14, "表10  VigiAccess数据库 ADEs 信号检测表（TOP 50）", Element.ALIGN_CENTER);
            //设置段落前后间距
            paragraphTable10Head.setSpacingAfter(10);
            paragraphTable10Head.setSpacingBefore(10);
            document.add(paragraphTable10Head);
            //表9
            PdfPTable table10 = new PdfPTable(6);
            table10.setTotalWidth(PageSize.A4.getWidth() - 100);
            table10.setLockedWidth(true);
            for (String s : nameList910) {
                PdfPCell cell = new PdfPCell(new Phrase(s, font));
                cell.setBackgroundColor(new BaseColor(221, 221, 221));
                cell.setMinimumHeight(20);
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table10.addCell(cell);
            }
            //设置表10内容
            Set<String> keySet = signalDictVigiMap.keySet();
            for (String key : keySet) {
                List<List<String>> lists = signalDictVigiMap.get(key);
                PdfPCell cell = new PdfPCell(new Phrase(signalDictVigiOnlyMap.get(key), fontTitle));
                cell.setMinimumHeight(20);
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_LEFT);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table10.addCell(cell);
                PdfPCell cellSpace = new PdfPCell(new Phrase("", font));
                for (int i1 = 0; i1 < 5; i1++) {
                    table10.addCell(cellSpace);
                }
                for (List<String> list : lists) {
                    for (String s : list) {
                        table10.addCell(createTableContent(s));
                    }
                }
            }
            document.add(table10);
        }
        if (StringUtils.isNotEmpty(signalDictExplain)) {
            Paragraph dataFda32 = createData(signalDictExplain);
            dataFda32.setFirstLineIndent(25);
            document.add(dataFda32);
        }

        //   || StringUtils.isNotEmpty(builderPicture.toString())
        if (CollUtil.isNotEmpty(pictureArr)) {
            //3.3 药物-ADEs 组合的时间扫描图谱
            Paragraph title33 = createHead(14, "3 ." + moduleTrendsTitleNum + "  药物-ADEs 组合的时间扫描图谱", Element.ALIGN_LEFT);
            title33.setSpacingAfter(10);
            title33.setSpacingBefore(10);
            document.add(title33);
            //说明
            String replaceAll32 = builderPicture.toString().replaceAll("、。", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph data32 = createData(replaceAll32);
            data32.setFirstLineIndent(25);
            document.add(data32);
            if (CollUtil.isNotEmpty(pictureArr)) {
                for (int i1 = 0; i1 < pictureArr.size(); i1++) {
                    JSONObject arrJSONObject = pictureArr.getJSONObject(i1);
                    JSONArray x = arrJSONObject.getJSONArray("x");
                    JSONArray y = arrJSONObject.getJSONArray("y");
                    JSONArray error = arrJSONObject.getJSONArray("error");
                    //开始拼接时间扫描图请求数据
                    QuickChart chart = new QuickChart();
                    chart.setWidth(500);
                    chart.setHeight(300);
                    chart.setVersion("2.9.4");
                    JSONObject configJson = new JSONObject();
                    configJson.put("type", "line");
                    configJson.put("data", new JSONObject());
                    configJson.getJSONObject("data").put("labels", new JSONArray());
                    JSONArray labels = configJson.getJSONObject("data").getJSONArray("labels");
                    for (int i2 = 0; i2 < x.size(); i2++) {
                        String xString = x.getString(i2);
                        labels.add(xString);
                    }
                    configJson.getJSONObject("data").put("datasets", new JSONArray());
                    configJson.getJSONObject("data").getJSONArray("datasets").add(new JSONObject());
                    JSONObject datasets0 = configJson.getJSONObject("data").getJSONArray("datasets").getJSONObject(0);
                    datasets0.put("label", "时间扫描图");
                    datasets0.put("data", new JSONArray());
                    JSONArray datasetsData = datasets0.getJSONArray("data");
                    for (int i2 = 0; i2 < y.size(); i2++) {
                        datasetsData.add(Double.parseDouble(y.getString(i2)));
                    }
                    datasets0.put("fill", false);
                    datasets0.put("errorBars", new JSONObject());
                    JSONObject errorBars = datasets0.getJSONObject("errorBars");
                    for (int i2 = 0; i2 < x.size(); i2++) {
                        String xString = x.getString(i2);
                        JSONArray errorJSONArray = error.getJSONArray(i2);
                        JSONObject inner = new JSONObject();
                        double aDouble = Double.parseDouble(y.getString(i2));
                        inner.put("plus", errorJSONArray.getDoubleValue(2) - aDouble);
                        inner.put("minus", aDouble - errorJSONArray.getDoubleValue(1));
                        errorBars.put(xString, inner);
                    }
                    configJson.put("options", new JSONObject());
                    configJson.getJSONObject("options").put("plugins", new JSONObject());
                    configJson.getJSONObject("options").getJSONObject("plugins").put("chartJsPluginErrorBars", new JSONObject());
                    configJson.getJSONObject("options").getJSONObject("plugins").getJSONObject("chartJsPluginErrorBars").put("color", "#aaa");
                    chart.setConfig(configJson.toJSONString());
                    String path = chart.getUrl();
                    //System.out.println(path);
                    try {
                        byte[] bytes = HttpUtil.downloadBytes(path);
                        if (bytes.length > 0) {
                            Image image = Image.getInstance(bytes);
                            image.setAlignment(Image.ALIGN_CENTER);
                            image.scaleAbsolute(500, 300);
                            document.add(image);

                            String title = arrJSONObject.getString("title");
                            Paragraph paragraphTable = createHead(14, title, Element.ALIGN_CENTER);
                            paragraphTable.setSpacingAfter(10);
                            paragraphTable.setSpacingBefore(10);
                            document.add(paragraphTable);
                        }
                    } catch (RuntimeException e) {
                        log.error(e.getCause().toString());
                    }
                }
            }
        }

        //四、结论
        Paragraph title4 = createHead(14, "四、结论", Element.ALIGN_LEFT);
        title4.setSpacingAfter(10);
        title4.setSpacingBefore(10);
        document.add(title4);
        //结论部分
        List<String> explainFda = new ArrayList<>();
        List<String> explainVigi = new ArrayList<>();
        if (!analysisOverview.isEmpty()) {
            JSONArray analysisList = analysisOverview.getJSONArray("list");
            if (CollUtil.isNotEmpty(analysisList)) {
                explainFda.add(analysisList.getString(1));
            }
        }
        //2.1
        String str21 = builder21Fda.toString();
        if (StringUtils.isNotEmpty(str21)) {
            int indexOf1 = str21.indexOf("：");
            str21 = str21.substring(indexOf1 + 1);
            int indexOf2 = str21.indexOf("。");
            str21 = str21.substring(0, indexOf2 + 1);
            explainFda.add(str21);
        }
        //2.2
        String str22 = builder22Fda.toString();
        if (StringUtils.isNotEmpty(str22)) {
            int indexOf1 = str22.indexOf("：");
            str22 = str22.substring(indexOf1 + 1);
            int indexOf2 = str22.indexOf("。");
            str22 = str22.substring(0, indexOf2 + 1);
            explainFda.add(str22);
        }
        //2.3
        String str23 = builder23FdaExplain.toString();
        if (StringUtils.isNotEmpty(str23)) {
            /*int indexOf1 = str23.indexOf("：");
            str23 = str23.substring(indexOf1 + 1);
            int indexOf2 = str23.indexOf("。");
            str23 = str23.substring(0, indexOf2 + 1);
            if (!"详见表 4。".equals(str23)) {
                explainFda.add(str23);
            }*/
            explainFda.add(str23);
        }
        //2.4
        String str24 = builder24FdaExplain.toString();
        if (StringUtils.isNotEmpty(str24)) {
            /*int indexOf1 = str24.indexOf("。");
            str24 = str24.substring(indexOf1 + 1);
            int indexOf2 = str24.indexOf("。");
            str24 = str24.substring(0, indexOf2 + 1);
            if (!"详见表 5。".equals(str24)) {
                explainFda.add(str24);
            }*/
            explainFda.add(str24);
        }
        //2.5
        String str25 = builder25FdaExplain.toString();
        if (StringUtils.isNotEmpty(str25)) {
            /*int indexOf1 = str25.indexOf("。");
            str25 = str25.substring(indexOf1 + 1);
            int indexOf2 = str25.indexOf("。");
            str25 = str25.substring(0, indexOf2 + 1);
            if (!"详见表 6。".equals(str25)) {
                explainFda.add(str25);
            }*/
            explainFda.add(str25);
        }
        if (CollUtil.isNotEmpty(ptFdaList)) {
            //3.1
            String str31 = builder31Fda.toString().replaceAll("、、", "、");
            if (StringUtils.isNotEmpty(str31)) {
                int indexOf1 = str31.indexOf("了");
                str31 = str31.substring(indexOf1 + 1);
                explainFda.add(str31);
            }
        }
        if (CollUtil.isNotEmpty(signalDictFdaMap)) {
            //3.2
            String str32 = builder32Fda.toString();
            if (StringUtils.isNotEmpty(str32)) {
                int indexOf2 = str32.indexOf("。");
                str32 = str32.substring(0, indexOf2 + 1);
                explainFda.add(str32);
            }
        }

        //vigi 2.1
        String strVigi21 = builder21Vigi.toString();
        if (StringUtils.isNotEmpty(strVigi21)) {
            int indexOf2 = strVigi21.indexOf("。");
            String anotherStr = strVigi21.substring(indexOf2 + 1);
            strVigi21 = strVigi21.substring(0, indexOf2 + 1);
            explainVigi.add(strVigi21);
            //拼接后续的内容
            int indexOf3 = anotherStr.indexOf("。");
            anotherStr = anotherStr.substring(0, indexOf3 + 1);
            explainVigi.add(anotherStr);
        }
        //vigi 3.1
        String strVigi31 = builder31Vigi.toString().replaceAll("、、", "、");
        if (StringUtils.isNotEmpty(strVigi31)) {
            int indexOf1 = strVigi31.indexOf("了");
            strVigi31 = strVigi31.substring(indexOf1 + 1);
            explainVigi.add(strVigi31);
        }
        //vigi 3.2
        String strVigi32 = builder32Vigi.toString();
        if (StringUtils.isNotEmpty(strVigi32)) {
            int indexOf2 = strVigi32.indexOf("。");
            strVigi32 = strVigi32.substring(0, indexOf2 + 1);
            explainVigi.add(strVigi32);
        }
        for (String s : explainFda) {
            String replace = s.replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            Paragraph data = createExplain(replace);
            data.setFirstLineIndent(25);
            document.add(data);
        }
        if (type == 2) {
            document.add(createData("    "));
            for (String s : explainVigi) {
                String replace = s.replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
                Paragraph data = createExplain(replace);
                data.setFirstLineIndent(25);
                document.add(data);
            }
        }

        //附录
        Paragraph titleAppendix = createHead(14, "附录", Element.ALIGN_LEFT);
        titleAppendix.setSpacingAfter(10);
        titleAppendix.setSpacingBefore(10);
        document.add(titleAppendix);
        //资料与方法
        Paragraph titleAppendix1 = createHead(14, "资料与方法", Element.ALIGN_LEFT);
        titleAppendix1.setSpacingAfter(10);
        titleAppendix1.setSpacingBefore(10);
        document.add(titleAppendix1);
        //数据来源
        Paragraph titleAppendix2 = createHead(14, "数据来源", Element.ALIGN_LEFT);
        titleAppendix2.setSpacingAfter(10);
        titleAppendix2.setSpacingBefore(10);
        document.add(titleAppendix2);
        //data
        Paragraph data1 = createData("本次研究数据来源于FAERS和WHO-Vigibase数据库中的公开数据-VigiAccess数据库。FAERS 包括了 FDA 收集的所有不良事件信息和用药错误信息( 包括欧洲报告可能与严重事件和其他非欧洲的数据有关)。其所有 ADEs 数据采用国际医学用语词典( Medical Dictionary for Drug Ｒegulatory Activities，MedDＲA)的首选术语( preferred terms，PTs) 进行编码。FAERS 数据库自 2004 年开始对外公开，每季度进行数据更新，数据信息量极大，可有效用于药品上市后安全性风险监测及评价，其可获得药物各个ADR的例数以及ADR的详情，包括年龄、性别、合并用药、转归等。VigiAccess是收集来自于卫生保健专业人员、制药公司的全球安全报告，公开的数据可以获得药物总的ADR的地区、年龄、性别、报告年份的分布，以及药物各个ADR的总例数。");
        data1.setFirstLineIndent(25);
        document.add(data1);
        //数据处理
        Paragraph titleAppendix3 = createHead(14, "数据处理", Element.ALIGN_LEFT);
        titleAppendix3.setSpacingAfter(10);
        titleAppendix3.setSpacingBefore(10);
        document.add(titleAppendix3);
        //data
        Paragraph data2 = createData("由于FAERS数据库和VigiAccess数据库的数据结构差异，两个库的数据处理方式不同：FAERS数据库：本研究从该库中提取2004年第1季度至2022年第3季度，共75个季度中所有包含" + originalI + "的ADE，剔除重复和错误数据后，筛选出以" + originalI + "为怀疑药物（首要怀疑和次要怀疑） " + (StringUtils.isNotEmpty(originalO) ? "并导致" + originalO : "") + " 的ADE报告进行分析。" + (type == 1 ? "" : "VigiAccess数据库：由于数据结构限制，本研究仅从该库中提取所有包含" + originalI + "的ADE报告进行分析，数据库限定时间为“建库时间”到2022-09-14。"));
        data2.setFirstLineIndent(25);
        document.add(data2);
        //信号检测方法
        Paragraph titleAppendix4 = createHead(14, "信号检测方法", Element.ALIGN_LEFT);
        titleAppendix4.setSpacingAfter(10);
        titleAppendix4.setSpacingBefore(10);
        document.add(titleAppendix4);
        //data
        Paragraph data3 = createData("本研究采用药物不良反应信号信息标准值( information component，IC) 、经验贝叶斯几何均值( empirical bayes geometric mean， EBGM ) 、报告比值比 ( reporting odds ratio，ROR) 进行信号检测。算法的具体计算公式及信号检测标准表 1，其中 a，b，c，d 的意义见表 2。");
        data3.setFirstLineIndent(25);
        document.add(data3);
        //（1）信息标准值
        Paragraph titleAppendix5 = createHead(14, "（1）信息标准值", Element.ALIGN_LEFT);
        titleAppendix5.setSpacingAfter(10);
        titleAppendix5.setSpacingBefore(10);
        document.add(titleAppendix5);
        //data
        Paragraph data4 = createData("IC 值是通过贝叶斯置信度递进神经网络 ( bayesian confidence propagation neural network， BCPNN) 获得的药物与不良反应之间的关联指标。由于药物不良反应监测数据库可以表达为由 a 种药物和 b 种不良反应构成的 a × b 矩阵。 基于目标不相称性测定分析理论，目标药物的不良反应事件在所有事件中出现的频率相对于背景事件明显不相称并达到一定的标准，则认为药物 A 和不良反应 B 是一个可疑的不良反应信号。因此，我们将 IC 值作为首个药物不良反应的识别指标。");
        data4.setFirstLineIndent(25);
        document.add(data4);
        //（2）经验贝叶斯几何均值
        Paragraph titleAppendix6 = createHead(14, "（2）经验贝叶斯几何均值", Element.ALIGN_LEFT);
        titleAppendix6.setSpacingAfter(10);
        titleAppendix6.setSpacingBefore(10);
        document.add(titleAppendix6);
        //data
        Paragraph data5 = createData("EBGM 是由伽玛泊松分布缩减法 ( gamma Poisson shrinker，GPS) 获得的药物与不良反应之间的关联指标，也是美国 FDA 使用的药物不良反应监测指标，基本假设是目标药物的不良反应报告数服从泊松分布。");
        data5.setFirstLineIndent(25);
        document.add(data5);
        //（3）报告比值比
        Paragraph titleAppendix7 = createHead(14, "（3）报告比值比", Element.ALIGN_LEFT);
        titleAppendix7.setSpacingAfter(10);
        titleAppendix7.setSpacingBefore(10);
        document.add(titleAppendix7);
        //data
        Paragraph data61 = createData("ROR 是通过频数法获得的药物与不良反应之间关系的关联指标，是暴露于某一药物的特定不良反应与其他不良反应的比值除以未暴露于该药物的特定不良反应与其他所有事件之比。");
        data61.setFirstLineIndent(25);
        document.add(data61);
        Paragraph data62 = createData("另外，本研究基于 BCPNN 检测方法绘制重点关注的药物-不良事件组合 IC 值及其 95%置信区间的时间扫描图谱。该图谱体现了数据库中目标不良事件随时间推移报告数增加时信号的变化趋势；若图谱呈平稳或上升趋势且置信区间逐渐变窄，则提示信号稳定且关联性强；若呈波动趋势则提示信号不稳定，关联性不强。");
        data62.setFirstLineIndent(25);
        document.add(data62);
        //插入图片
        Paragraph titleImage = createHead(14, "计算公式和信号检测标准", Element.ALIGN_LEFT);
        titleImage.setAlignment(Element.ALIGN_CENTER);
        titleImage.setSpacingAfter(10);
        titleImage.setSpacingBefore(10);
        document.add(titleImage);
        ClassPathResource classPathResource = new ClassPathResource("/static/data.png");
        InputStream inputStreamImg = classPathResource.getInputStream();
        byte[] bytes = IOUtils.toByteArray(inputStreamImg);
        Image image = Image.getInstance(bytes);
        image.setAlignment(Image.ALIGN_CENTER);
        image.scaleAbsolute(500, 425);
        document.add(image);
        //创建 比值失衡测量法四格表
        Paragraph titleTable = createHead(14, "比值失衡测量法四格表", Element.ALIGN_LEFT);
        titleTable.setAlignment(Element.ALIGN_CENTER);
        titleTable.setSpacingAfter(10);
        titleTable.setSpacingBefore(10);
        document.add(titleTable);
        //data
        List<String> nameList = Arrays.asList("项目", "目标ADEs报告数", "其他ADEs报告数", "合计");
        PdfPTable table = new PdfPTable(4);
        table.setTotalWidth(PageSize.A4.getWidth() - 100);
        table.setLockedWidth(true);
        for (String s : nameList) {
            PdfPCell cell = new PdfPCell(new Phrase(s, font));
            cell.setBackgroundColor(new BaseColor(221, 221, 221));
            cell.setMinimumHeight(20);
            cell.setUseAscender(true);
            cell.setHorizontalAlignment(Element.ALIGN_CENTER);
            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
            table.addCell(cell);
        }
        //设置内容
        List<List<String>> dataList = new ArrayList<>();
        List<String> lastData1 = Arrays.asList("目标药物", "a", "b", "a+b");
        List<String> lastData2 = Arrays.asList("其他药物", "c", "d", "c+d");
        List<String> lastData3 = Arrays.asList("合计", "a+c", "b+d", "a+b+c+d");
        dataList.add(lastData1);
        dataList.add(lastData2);
        dataList.add(lastData3);
        for (List<String> list : dataList) {
            for (String s : list) {
                table.addCell(createTableContent(s));
            }
        }
        document.add(table);


        // 关闭文档，才能输出
        document.close();
        writer.close();
    }

    @Override
    public void downloadWord(String id, HttpServletResponse response) throws IOException, com.lowagie.text.DocumentException {
        response.setCharacterEncoding("UTF-8");
        response.setContentType("application/octet-stream");

        Condition condition = mongoTemplate.findById(id, Condition.class);
        //1-i+o 2-i
        Integer type = 1;
        //用户输入条件
        String conditionData = "";
        String originalI = "";
        String originalO = "";
        String i = "";
        String o = "";
        if (condition != null) {
            if (StringUtils.isNotBlank(condition.getOriginalI())){
                originalI = condition.getOriginalI();
            }
            if (StringUtils.isNotBlank(condition.getOriginalO())){
                originalO = condition.getOriginalO();
            }
            if (StringUtils.isNotBlank(condition.getI())){
                i = condition.getI();
            }
            if (StringUtils.isNotBlank(condition.getO())){
                o = condition.getO();
            }
            conditionData = condition.getCondition();
            type = condition.getType();
        }
        String fileName = URLEncoder.encode("【药品安全性分析报告】", "UTF-8");
        if (StringUtils.isNotEmpty(originalI)) {
            if (!originalI.equals(i)) {
                fileName = fileName + URLEncoder.encode(originalI, "UTF-8") + "_" + i;
            } else {
                fileName = fileName + URLEncoder.encode(originalI, "UTF-8");
            }
        }
        if (StringUtils.isNotEmpty(originalO)) {
            if (!originalO.equals(o)) {
                fileName = fileName + "、" + URLEncoder.encode(originalO, "UTF-8") + "_" + o;
            } else {
                fileName = fileName + "、" + URLEncoder.encode(originalO, "UTF-8");
            }
        }
        SimpleDateFormat formatName = new SimpleDateFormat("yyyyMMdd");
        fileName = fileName + "-" + formatName.format(new Date());
        log.info("----------开始进行报告[{}]的下载----------", fileName);
        response.setHeader("Content-Disposition", "attachment;fileName=" + fileName + ".doc");
        ServletOutputStream outputStream = response.getOutputStream();
        //创建一个文档（默认大小A4，边距36, 36, 36, 36）
        com.lowagie.text.Document document = new com.lowagie.text.Document();
        //设置文档大小
        document.setPageSize(com.lowagie.text.PageSize.A4);
        document.setMargins(50, 50, 50, 50);
        //创建writer，通过writer将文档写入磁盘
        RtfWriter2 writer = RtfWriter2.getInstance(document, outputStream);
        //打开文档，只有打开后才能往里面加东西
        document.open();
        //设置报告名称
        com.lowagie.text.Paragraph paragraphTitle = createHeadWord(43, "\n\n药品安全性分析报告", Element.ALIGN_LEFT);
        //设置对齐方式
        paragraphTitle.setAlignment(Element.ALIGN_CENTER);
        document.add(paragraphTitle);
        //设置公司名称
        com.lowagie.text.Paragraph paragraphName = createHeadWord(23, "\n\n\n\n\n\n\n\n灵犀量子（北京）医疗科技有限公司", Element.ALIGN_LEFT);
        paragraphName.setAlignment(Element.ALIGN_CENTER);
        document.add(paragraphName);
        //设置标题时间
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd");
        String formatTime = format.format(new Date());
        com.lowagie.text.Font timeFont = createFontWord(23, Font.NORMAL);
        com.lowagie.text.Paragraph paragraphTime = new com.lowagie.text.Paragraph(formatTime, timeFont);
        paragraphTime.setAlignment(Element.ALIGN_CENTER);
        document.add(paragraphTime);
        //开始新开一页进行正文的拼接
        document.newPage();
        //创建完成新的页之后如果不添加内容的话，会忽略新添加的页
        //fda
        JSONObject fda = searchAll(id, 1);
        //vigi
        JSONObject vigi;
        if (type == 1) {
            vigi = new JSONObject();
        } else {
            vigi = searchAll(id, 2);
        }
        //分析综述 analysisOverview
        JSONObject analysisOverview = analysisOverview(id, 1);

        //2.1 基本情况数据
        //不良反应报告总数
        int allNum = 0;
        //性别
        JSONObject sexDataFda = new JSONObject();
        JSONObject sexDataVigi = new JSONObject();
        //年龄
        JSONObject ageDataFda = new JSONObject();
        JSONObject ageDataVigi = new JSONObject();
        //报告国家
        JSONObject countryDataFda = new JSONObject();
        JSONObject countryDataVigi = new JSONObject();
        //职业
        JSONObject reportDataFda = new JSONObject();
        //不良反应逐年上报情况
        JSONObject reportYearDataFda = new JSONObject();
        JSONObject reportYearDataVigi = new JSONObject();
        //严重不良反应
        JSONObject adverseReactionsDataFda = new JSONObject();
        JSONObject adverseReactionsDataVigi = new JSONObject();
        //2.1结论
        StringBuilder builder21Fda = new StringBuilder();
        StringBuilder builder21Vigi = new StringBuilder();
        //用于拼接报告的结论
        StringBuilder fda21 = new StringBuilder();
        StringBuilder vigi21 = new StringBuilder();
        //2.2 用药情况分析
        //剂型
        JSONObject doseFormDataFda = new JSONObject();
        //给药途径
        JSONObject routeDataFda = new JSONObject();
        //给药剂量
        JSONObject doseAmtDataFda = new JSONObject();
        //持续用药时间
        JSONObject durTimeDataFda = new JSONObject();
        //2.2结论
        StringBuilder builder22Fda = new StringBuilder();
        //用于拼接报告的结论
        StringBuilder fda22 = new StringBuilder();
        //2.3 用药适应征分析
        List<List<String>> indiPtList = new ArrayList<>();
        StringBuilder builder23Fda = new StringBuilder();
        //用于拼接报告的结论
        StringBuilder fda23 = new StringBuilder();
        //2.4 给药方案及不良反应发生时间分布
        //给药方案
        JSONObject drugNumData = new JSONObject();
        //不良反应发生时间分布
        JSONObject cutDtTimeData = new JSONObject();
        StringBuilder builder24Fda = new StringBuilder();
        StringBuilder fda24 = new StringBuilder();
        //2.5 治疗与转归
        Map<String, List<List<String>>> dechalAndRechalMap = new LinkedHashMap<>();
        StringBuilder builder25Fda = new StringBuilder();
        StringBuilder fda25 = new StringBuilder();
        //3.1 不良反应分析结果
        List<List<String>> ptFdaList = new ArrayList<>();
        List<List<String>> ptVigiList = new ArrayList<>();
        StringBuilder builder31Fda = new StringBuilder();
        StringBuilder builder31Vigi = new StringBuilder();
        StringBuilder fda31 = new StringBuilder();
        StringBuilder vigi31 = new StringBuilder();
        //3.2 各系统器官分类的ADR信号数及ADEs报告数
        Map<String, List<List<String>>> signalDictFdaMap = new HashMap<>();
        Map<String, String> signalDictFdaOnlyMap = new HashMap<>();
        String signalDictExplain = "";
        Map<String, List<List<String>>> signalDictVigiMap = new HashMap<>();
        Map<String, String> signalDictVigiOnlyMap = new HashMap<>();
        StringBuilder builder32Fda = new StringBuilder();
        StringBuilder builder32Vigi = new StringBuilder();
        StringBuilder fda32 = new StringBuilder();
        StringBuilder vigi32 = new StringBuilder();
        //3.3 药物-ADEs 组合的时间扫描图谱
        JSONArray pictureArr = new JSONArray();
        StringBuilder builderPicture = new StringBuilder();
        if (CollUtil.isNotEmpty(fda) || CollUtil.isNotEmpty(vigi)) {
            if (!fda.isEmpty()) {
                //基本情况数据
                JSONObject basicInformation = fda.getJSONObject("basicInformation");
                if (CollUtil.isNotEmpty(basicInformation)) {
                    //不良反应报告总数
                    allNum = basicInformation.getInteger("allNum");
                    builder21Fda.append("FAERS数据库共获得不良反应报告").append(allNum).append("例。在已知的数据中：");
                    //人群分布
                    JSONObject populationDistribution = basicInformation.getJSONObject("populationDistribution");
                    if (CollUtil.isNotEmpty(populationDistribution)) {
                        //性别
                        JSONArray reportSex = populationDistribution.getJSONArray("reportSex");
                        if (CollUtil.isNotEmpty(reportSex)) {
                            String man = "0%";
                            String woman = "0%";
                            String maxSex = "";
                            int maxSexNum = Integer.MIN_VALUE;
                            for (int i1 = 0; i1 < reportSex.size(); i1++) {
                                JSONObject json = reportSex.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                if (!"未知".equals(name)) {
                                    try {
                                        int anInt = Integer.parseInt(num);
                                        if (anInt > maxSexNum) {
                                            maxSexNum = anInt;
                                            maxSex = name;
                                        }
                                    } catch (NumberFormatException e) {
                                        e.printStackTrace();
                                    }
                                }
                                String percentage = json.getString("percentage");
                                if ("男".equals(name)) {
                                    man = percentage;
                                }
                                if ("女".equals(name)) {
                                    woman = percentage;
                                }
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                sexDataFda.put(name, inner);
                            }
                            builder21Fda.append("性别构成上，男性（").append(man).append("）").append("男".equals(maxSex) ? "大于" : "小于").append("女性（").append(woman).append("）；");
                            fda21.append("性别构成上，男性（").append(man).append("）").append("男".equals(maxSex) ? "大于" : "小于").append("女性（").append(woman).append("）；");
                        }
                        //年龄
                        JSONArray reportAge = populationDistribution.getJSONArray("reportAge");
                        if (CollUtil.isNotEmpty(reportAge)) {
                            builder21Fda.append("；");
                            String maxAge = "";
                            String maxPercentage = "";
                            int maxAgeNum = Integer.MIN_VALUE;
                            for (int i1 = 0; i1 < reportAge.size(); i1++) {
                                JSONObject json = reportAge.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                try {
                                    int anInt = Integer.parseInt(num);
                                    if (anInt > maxAgeNum) {
                                        if (!"未知".equals(name)) {
                                            maxAgeNum = anInt;
                                            maxAge = name;
                                            maxPercentage = percentage;
                                        }
                                    }
                                } catch (NumberFormatException e) {
                                    e.printStackTrace();
                                }

                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                ageDataFda.put(name, inner);
                            }
                            builder21Fda.append("年龄主要集中在").append(maxAge).append("（").append(maxPercentage).append("）");
                            fda21.append("年龄主要集中在").append(maxAge).append("（").append(maxPercentage).append("）；");
                        }
                    }
                    //报告分布
                    JSONObject reportDistribution = basicInformation.getJSONObject("reportDistribution");
                    if (CollUtil.isNotEmpty(reportDistribution)) {
                        //不良反应逐年上报情况
                        JSONArray reportYear = reportDistribution.getJSONArray("reportYear");
                        if (CollUtil.isNotEmpty(reportYear)) {
                            for (int i1 = 0; i1 < reportYear.size(); i1++) {
                                JSONObject json = reportYear.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                reportYearDataFda.put(name, inner);
                            }
                        }
                        //地区分布
                        JSONArray reportCountry = reportDistribution.getJSONArray("reportCountry");
                        if (CollUtil.isNotEmpty(reportCountry)) {
                            int maxIntCountry = Integer.MIN_VALUE;
                            builder21Fda.append("；");
                            String maxCountry = "";
                            String asiaNum = "";
                            for (int i1 = 0; i1 < reportCountry.size(); i1++) {
                                JSONObject json = reportCountry.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                if ("亚洲".equals(name)) {
                                    asiaNum = num;
                                }
                                try {
                                    int anInt = Integer.parseInt(num);
                                    if (!"未知".equals(name)) {
                                        if (anInt > maxIntCountry) {
                                            maxIntCountry = anInt;
                                            maxCountry = name;
                                        }
                                    }
                                } catch (NumberFormatException e) {
                                    e.printStackTrace();
                                }
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                countryDataFda.put(name, inner);
                            }
                            builder21Fda.append(maxCountry).append("报告数最多").append("，亚洲的报告数有").append(asiaNum).append("份");
                            fda21.append(maxCountry).append("报告数最多").append("，亚洲的报告数有").append(asiaNum).append("份；");
                        }
                        //职业分布
                        JSONArray reportOccupation = reportDistribution.getJSONArray("reportOccupation");
                        if (CollUtil.isNotEmpty(reportOccupation)) {
                            builder21Fda.append("；");
                            String maxOccupation = reportOccupation.getJSONObject(0).getString("name");
                            if ("未知".equals(maxOccupation) && reportOccupation.size() > 1) {
                                maxOccupation = reportOccupation.getJSONObject(1).getString("name");
                            }
                            for (int i1 = 0; i1 < reportOccupation.size(); i1++) {
                                JSONObject json = reportOccupation.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                reportDataFda.put(name, inner);
                            }
                            if (StringUtils.isNotBlank(maxOccupation) && !"未知".equals(maxOccupation)) {
                                builder21Fda.append("上报者主要为").append(maxOccupation);
                                fda21.append("上报者主要为").append(maxOccupation).append("；");
                            }
                        }
                    }
                }
                //严重不良反应分布
                JSONObject outcomeAnalysis = fda.getJSONObject("outcomeAnalysis");
                if (CollUtil.isNotEmpty(outcomeAnalysis)) {
                    //严重不良反应结局
                    JSONArray adverseReactions = outcomeAnalysis.getJSONArray("adverseReactions");
                    if (CollUtil.isNotEmpty(adverseReactions)) {
                        builder21Fda.append("；");
                        String maxOccupation = adverseReactions.getJSONObject(0).getString("name");
                        String maxNum = adverseReactions.getJSONObject(0).getString("num");
                        String maxPercentage = adverseReactions.getJSONObject(0).getString("percentage");
                        for (int i1 = 0; i1 < adverseReactions.size(); i1++) {
                            JSONObject json = adverseReactions.getJSONObject(i1);
                            String name = json.getString("name");
                            String num = json.getString("num");
                            String percentage = json.getString("percentage");
                            JSONObject inner = new JSONObject();
                            inner.put("name", name);
                            inner.put("num", num);
                            inner.put("percentage", percentage);
                            adverseReactionsDataFda.put(name, inner);
                        }
                        builder21Fda.append(originalI).append(" 严重不良反应结局中以").append(maxOccupation).append("报告数最多（").append(maxNum).append("例，").append(maxPercentage).append("）");
                        fda21.append(originalI).append(" 严重不良反应结局中以").append(maxOccupation).append("报告数最多（").append(maxNum).append("例，").append(maxPercentage).append("）。");
                    }
                    //治疗和转归
                    JSONObject dechalAndRechal = outcomeAnalysis.getJSONObject("dechalAndRechal");
                    if (CollUtil.isNotEmpty(dechalAndRechal)) {
                        if (type == 1) {
                            //i+o
                            builder25Fda.append("FAERS数据库中，").append(originalI).append("致").append(originalO).append("的报告共有").append(allNum).append("例。");
                        } else {
                            //i
                            builder25Fda.append("FAERS数据库显示：在").append(allNum).append("份 ADEs 报告中，");
                        }
                        Set<String> set = dechalAndRechal.keySet();
                        //停药后消失
                        String stopDisappear = "";
                        //停药后再次出现
                        String stopAppear = "";
                        //重新用药后再次出现
                        String appear = "";
                        for (String s : set) {
                            List<List<String>> outList = new ArrayList<>();
                            JSONArray jsonArray = dechalAndRechal.getJSONArray(s);
                            for (int i1 = 0; i1 < jsonArray.size(); i1++) {
                                JSONObject jsonObject = jsonArray.getJSONObject(i1);
                                String name = jsonObject.getString("name");
                                String num = jsonObject.getString("num");
                                String percentage = jsonObject.getString("percentage");
                                List<String> innerList = new ArrayList<>();
                                innerList.add(name);
                                innerList.add(num);
                                innerList.add(percentage);
                                outList.add(innerList);
                                if ("停药或减药后反应是否减轻或消失".equals(s)) {
                                    if (name.contains("（减轻、消失）")) {
                                        stopDisappear = percentage;
                                    }
                                    if (name.contains("（未消失或减轻）")) {
                                        stopAppear = percentage;
                                    }
                                } else {
                                    if (name.contains("（出现）")) {
                                        appear = percentage;
                                    }
                                }
                            }
                            dechalAndRechalMap.put(s, outList);
                        }
                        String anotherPercentage1 = "";
                        String anotherPercentage2 = "";
                        if (StringUtils.isNotEmpty(stopDisappear) && StringUtils.isNotEmpty(stopAppear)) {
                            try {
                                double v1 = Double.parseDouble(stopDisappear.split("%")[0]);
                                double v2 = Double.parseDouble(stopAppear.split("%")[0]);
                                anotherPercentage1 = (100 - v1 - v2) + "%";
                            } catch (NumberFormatException e) {
                                log.error("治疗与转归百分比转化异常[{}], [{}]", stopDisappear, stopAppear);
                            }
                        } else if (StringUtils.isNotEmpty(stopDisappear)) {
                            try {
                                double v1 = Double.parseDouble(stopDisappear.split("%")[0]);
                                anotherPercentage1 = (100 - v1) + "%";
                            } catch (NumberFormatException e) {
                                log.error("治疗与转归百分比转化异常[{}]", stopDisappear);
                            }
                        } else {
                            try {
                                double v2 = Double.parseDouble(stopAppear.split("%")[0]);
                                anotherPercentage1 = (100 - v2) + "%";
                            } catch (NumberFormatException e) {
                                log.error("治疗与转归百分比转化异常[{}]", stopAppear);
                            }
                        }
                        if (StringUtils.isNotEmpty(anotherPercentage1)) {
                            //取小数点后两位
                            anotherPercentage1 = BigDecimal.valueOf(Double.parseDouble(anotherPercentage1.split("%")[0])).divide(BigDecimal.valueOf(1), 2, RoundingMode.HALF_UP).doubleValue() + "%";
                        }
                        if (StringUtils.isNotEmpty(appear)) {
                            try {
                                double v2 = Double.parseDouble(appear.split("%")[0]);
                                anotherPercentage2 = (100 - v2) + "%";
                            } catch (NumberFormatException e) {
                                log.error("治疗与转归百分比转化异常[{}]", appear);
                            }
                        }
                        builder25Fda.append("停药或减药后反应减轻或消失的占比为").append(stopDisappear).append("，反应未减轻或未消失的占比为").append(stopAppear).append("，其余占比为").append(anotherPercentage1).append("；重新用药后反应再次出现的占比为").append(appear).append("其余的占比为").append(anotherPercentage2).append("。详见表 6。");
                        fda25.append("停药或减药后反应减轻或消失的占比为").append(stopDisappear).append("，反应未减轻或未消失的占比为").append(stopAppear).append("，其余占比为").append(anotherPercentage1).append("；重新用药后反应再次出现的占比为").append(appear).append("其余的占比为").append(anotherPercentage2).append("。");
                    }
                }
                builder21Fda.append("。").append("其人口学特征及严重不良事件构成情况见表 1。不良反应逐年上报情况详见表 2。");
                //用药情况分析
                JSONObject drugAnalysis = fda.getJSONObject("drugAnalysis");
                if (CollUtil.isNotEmpty(drugAnalysis)) {
                    if (type == 1) {
                        //i+o
                        builder22Fda.append("FAERS数据库中，").append(originalI).append("致").append(originalO).append("的报告共有").append(allNum).append("例。在已知的数据中：");
                    } else {
                        //i
                        builder22Fda.append("FAERS数据库的").append(allNum).append("份 ADEs 报告，在已知数据中：");
                    }
                    //用法用量分析
                    JSONObject usageAndDosage = drugAnalysis.getJSONObject("usageAndDosage");
                    if (CollUtil.isNotEmpty(usageAndDosage)) {
                        //剂型分布 doseFormList
                        JSONArray doseFormList = usageAndDosage.getJSONArray("doseFormList");
                        if (CollUtil.isNotEmpty(doseFormList)) {
                            String maxDoseForm = doseFormList.getJSONObject(0).getString("name");
                            if ("unknown".equals(maxDoseForm) && doseFormList.size() > 1) {
                                maxDoseForm = doseFormList.getJSONObject(1).getString("name");
                            }
                            for (int i1 = 0; i1 < doseFormList.size(); i1++) {
                                JSONObject json = doseFormList.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                doseFormDataFda.put(name, inner);
                            }
                            if (StringUtils.isNotBlank(maxDoseForm) && !"unknown".equals(maxDoseForm)) {
                                builder22Fda.append("该药品报告最多的剂型为").append(maxDoseForm).append("；");
                                fda22.append("该药品报告最多的剂型为").append(maxDoseForm).append("；");
                            }
                        }
                        //给药用途分布 route
                        JSONArray route = usageAndDosage.getJSONArray("route");
                        if (CollUtil.isNotEmpty(route)) {
                            String maxRoute = route.getJSONObject(0).getString("name");
                            if ("未知".equals(maxRoute) && route.size() > 1) {
                                maxRoute = route.getJSONObject(1).getString("name");
                            }
                            for (int i1 = 0; i1 < route.size(); i1++) {
                                JSONObject json = route.getJSONObject(i1);
                                String name = json.getString("name");
                                String englishName = json.getString("englishName");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                routeDataFda.put(name + "（" + englishName + "）", inner);
                            }
                            if (StringUtils.isNotBlank(maxRoute) && !"未知".equals(maxRoute)) {
                                builder22Fda.append("给药途径报告最多的是").append(maxRoute).append("；");
                                fda22.append("给药途径报告最多的是").append(maxRoute).append("；");
                            }
                        }
                        //计量分布 doseAmt
                        JSONArray doseAmt = usageAndDosage.getJSONArray("doseAmt");
                        if (CollUtil.isNotEmpty(doseAmt)) {
                            String maxDoseAmt = doseAmt.getJSONObject(0).getString("name");
                            if ("unknown".equals(maxDoseAmt) && doseAmt.size() > 1) {
                                maxDoseAmt = doseAmt.getJSONObject(1).getString("name");
                            }
                            for (int i1 = 0; i1 < doseAmt.size(); i1++) {
                                JSONObject json = doseAmt.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                doseAmtDataFda.put(name, inner);
                            }
                            if (StringUtils.isNotBlank(maxDoseAmt) && !"unknown".equals(maxDoseAmt)) {
                                builder22Fda.append("最常用的给药剂量为").append(maxDoseAmt).append("；");
                                fda22.append("最常用的给药剂量为").append(maxDoseAmt).append("；");
                            }
                        }
                        //给药方案 drugNumList
                        JSONArray drugNumList = usageAndDosage.getJSONArray("drugNumList");
                        if (CollUtil.isNotEmpty(drugNumList)) {
                            if (type == 1) {
                                //i+o
                                builder24Fda.append("FAERS数据库中，").append(originalI).append("致").append(originalO).append("的报告共有").append(allNum).append("例。");
                            } else {
                                //i
                                builder24Fda.append("FAERS数据库显示：在").append(allNum).append("份 ADEs 报告中，");
                            }
                            String maxDoseAmt = drugNumList.getJSONObject(0).getString("percentage");
                            String minDoseAmt = "";
                            if (drugNumList.size() > 1) {
                                minDoseAmt = drugNumList.getJSONObject(1).getString("percentage");
                            }
                            for (int i1 = 0; i1 < drugNumList.size(); i1++) {
                                JSONObject json = drugNumList.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                drugNumData.put(name, inner);
                            }
                            if (StringUtils.isNotBlank(minDoseAmt)) {
                                builder24Fda.append("使用联用药治疗的患者占").append(maxDoseAmt).append("，使用单药治疗的患者占").append(minDoseAmt).append("；");
                                fda24.append("使用联用药治疗的患者占").append(maxDoseAmt).append("，使用单药治疗的患者占").append(minDoseAmt).append("；");
                            }else {
                                builder24Fda.append("使用联用药治疗的患者占").append(maxDoseAmt).append("；");
                                fda24.append("使用联用药治疗的患者占").append(maxDoseAmt).append("；");
                            }
                        }
                    }
                    //治疗时间/不良反应发生时间
                    JSONObject time = drugAnalysis.getJSONObject("time");
                    if (CollUtil.isNotEmpty(time)) {
                        //治疗持续时间分布 durTime
                        JSONArray durTime = time.getJSONArray("durTime");
                        if (CollUtil.isNotEmpty(durTime)) {
                            String maxDurTime = durTime.getJSONObject(0).getString("name");
                            if ("unknown".equals(maxDurTime) && durTime.size() > 1) {
                                maxDurTime = durTime.getJSONObject(1).getString("name");
                            }
                            for (int i1 = 0; i1 < durTime.size(); i1++) {
                                JSONObject json = durTime.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                durTimeDataFda.put(name, inner);
                            }
                            if (StringUtils.isNotBlank(maxDurTime) && !"unknown".equals(maxDurTime)) {
                                builder22Fda.append("该药用药持续时间占比最高的是").append(maxDurTime).append("。").append("详见表 3。");
                                fda22.append("该药用药持续时间占比最高的是").append(maxDurTime).append("。");
                            }
                        }
                        //不良反应时间分布 cutDtTime
                        JSONArray cutDtTime = time.getJSONArray("cutDtTime");
                        if (CollUtil.isNotEmpty(cutDtTime)) {
                            String maxDurTime = cutDtTime.getJSONObject(0).getString("name");
                            int indexCutDt = 1;
                            while ("unknown".equals(maxDurTime) || "Other".equals(maxDurTime)) {
                                maxDurTime = cutDtTime.getJSONObject(indexCutDt).getString("name");
                                indexCutDt++;
                            }
                            for (int i1 = 0; i1 < cutDtTime.size(); i1++) {
                                JSONObject json = cutDtTime.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                cutDtTimeData.put(name, inner);
                            }
                            if (StringUtils.isNotBlank(maxDurTime) && !"unknown".equals(maxDurTime) && !"Other".equals(maxDurTime)) {
                                builder24Fda.append("不良反应多发生在用药后").append(maxDurTime).append("。");
                                fda24.append("不良反应多发生在用药后").append(maxDurTime).append("。");
                            }
                        }
                    }
                    //适应症分布
                    JSONArray indiPt = drugAnalysis.getJSONArray("indiPt");
                    if (CollUtil.isNotEmpty(indiPt)) {
                        if (type == 1) {
                            //i+o
                            builder23Fda.append("FAERS数据库中，").append(originalI).append("致").append(originalO).append("的报告共有").append(allNum).append("例。常见的适应症有");
                            fda23.append("常见的适应症有");
                        } else {
                            //i
                            builder23Fda.append("FAERS数据库的").append(allNum).append("份 ADEs 报告，在已知数据中：多在");
                            fda23.append("多在");
                        }
                        for (int i1 = 0; i1 < indiPt.size(); i1++) {
                            List<String> inner = new ArrayList<>();
                            JSONObject ptJSONObject = indiPt.getJSONObject(i1);
                            inner.add(ptJSONObject.getString("name") + "（" + ptJSONObject.getString("englishName") + "）");
                            inner.add(ptJSONObject.getString("num"));
                            inner.add(ptJSONObject.getString("percentage"));
                            indiPtList.add(inner);
                        }
                        //取前5展示到说明中
                        /*int maxRange = Math.min(indiPtList.size(), 5);
                        for (int j = 0; j < maxRange; j++) {
                            builder23Fda.append(indiPtList.get(j).get(0)).append("，");
                        }*/
                        int num = 0;
                        for (List<String> list : indiPtList) {
                            String s = list.get(0);
                            if (s.contains("未知")) {
                                continue;
                            }
                            num++;
                            builder23Fda.append(s).append("，");
                            fda23.append(s).append("，");
                            if (num >= 5) {
                                break;
                            }
                        }
                        if (type == 1) {
                            //i+o
                            builder23Fda.append("。");
                            fda23.append("。");
                        } else {
                            //i
                            builder23Fda.append("等情况下出现了使用。");
                            fda23.append("等情况下出现了使用。");
                        }
                        builder23Fda.append("详见表 4。");
                    }
                }
                //不良反应及信号分析 adverseReactionSignal
                JSONObject adverseReactionSignal = fda.getJSONObject("adverseReactionSignal");
                if (CollUtil.isNotEmpty(adverseReactionSignal)) {
                    //不良反应分析 pt
                    JSONArray pt = adverseReactionSignal.getJSONArray("pt");
                    if (CollUtil.isNotEmpty(pt)) {
                        builder31Fda.append("FAERS数据库显示：在").append(originalI).append("相关的").append(allNum).append("份 ADEs 报告中，表 7列出了报告前 50 位的ADEs，包括");
                        fda31.append("在").append(originalI).append("相关的").append(allNum).append("份 ADEs 报告中，列出了报告前 20 位的ADEs，包括");
                        int range = 5;
                        if (pt.size() < 5) {
                            range = pt.size();
                        }
                        Map<String, Integer> onlyMap = new HashMap<>();
                        for (int i1 = 0; i1 < pt.size(); i1++) {
                            JSONObject ptJSONObject = pt.getJSONObject(i1);
                            String englishName = ptJSONObject.getString("englishName");
                            String name = ptJSONObject.getString("name");
                            String num = ptJSONObject.getString("num");
                            String percentage = ptJSONObject.getString("percentage");
                            String diseaseType = ptJSONObject.getString("diseaseType");
                            if (onlyMap.containsKey(diseaseType)) {
                                onlyMap.put(diseaseType, onlyMap.get(diseaseType) + 1);
                            } else {
                                onlyMap.put(diseaseType, 1);
                            }
                            if (i1 < range) {
                                if (i1 == range - 2) {
                                    builder31Fda.append(name).append("和");
                                    fda31.append(name).append("和");
                                } else if (i1 == range - 1) {
                                    builder31Fda.append(name).append("等");
                                    fda31.append(name).append("等");
                                } else {
                                    builder31Fda.append(name).append("、");
                                    fda31.append(name).append("、");
                                }
                            }
                            List<String> inner = Arrays.asList(englishName, name, num, percentage);
                            ptFdaList.add(inner);
                        }
                        builder31Fda.append("，涉及");
                        fda31.append("，涉及");
                        int range2 = 5;
                        if (onlyMap.size() < 5) {
                            range2 = onlyMap.size();
                        }
                        int index = 0;
                        Set<Map.Entry<String, Integer>> entries = onlyMap.entrySet();
                        for (Map.Entry<String, Integer> entry : entries) {
                            if (index >= range2) {
                                break;
                            }
                            String key = entry.getKey();
                            if (index == range2 - 2) {
                                builder31Fda.append(key).append("和");
                                fda31.append(key).append("和");
                            } else if (index == range2 - 1) {
                                builder31Fda.append(key).append("等");
                                fda31.append(key).append("等");
                            } else {
                                builder31Fda.append(key).append("、");
                                fda31.append(key).append("、");
                            }
                            index++;
                        }
                        builder31Fda.append("系统。");
                        fda31.append("系统。");
                    }
                    //各系统器官分类的ADR信号数及ADEs报告数 signalDict
                    JSONArray signalDict = adverseReactionSignal.getJSONArray("signalDict");
                    String signalExplain = adverseReactionSignal.getString("signalDictExplain");
                    if (StringUtils.isNotBlank(signalExplain) && !signalExplain.contains("属于")) {
                        if (CollUtil.isNotEmpty(signalDict)) {
                            int signalDictTypeCount = adverseReactionSignal.getInteger("signalDictTypeCount");
                            int signalDictNumCount = adverseReactionSignal.getInteger("signalDictNumCount");
                            builder32Fda.append("FAERS数据库共获得 ").append(signalDictNumCount).append("个有信号的ADEs，共涉及").append(signalDictTypeCount).append("个SOC。使用国际医学用语词典（MedDRA）术语集系统器官分类（system organ class,SOC）对有信号的ADEs 进行分类。表 9为TOP50的信号以及信号所在的系统-器官情况。");
                            fda32.append("FAERS数据库共获得 ").append(signalDictNumCount).append("个有信号的ADEs，共涉及").append(signalDictTypeCount).append("个SOC。使用国际医学用语词典（MedDRA）术语集系统器官分类（system organ class,SOC）对有信号的ADEs 进行分类。");
                            for (int i1 = 0; i1 < signalDict.size(); i1++) {
                                JSONObject dictJSONObject = signalDict.getJSONObject(i1);
                                String outEnglishName = dictJSONObject.getString("outEnglishName");
                                String englishName = dictJSONObject.getString("englishName");
                                String name = dictJSONObject.getString("name");
                                String num = dictJSONObject.getString("num");
                                String outName = dictJSONObject.getString("outName");
                                String ror = dictJSONObject.getString("ror");
                                String ebgm = dictJSONObject.getString("ebgm");
                                String ic = dictJSONObject.getString("ic");
                                //取外层key全称
                                if (!signalDictFdaOnlyMap.containsKey(outName)) {
                                    signalDictFdaOnlyMap.put(outName, outEnglishName);
                                }
                                if (signalDictFdaMap.containsKey(outName)) {
                                    List<List<String>> lists = signalDictFdaMap.get(outName);
                                    lists.add(Arrays.asList(englishName, name, num, ror, ebgm, ic));
                                } else {
                                    List<List<String>> lists = new ArrayList<>();
                                    lists.add(Arrays.asList(englishName, name, num, ror, ebgm, ic));
                                    signalDictFdaMap.put(outName, lists);
                                }
                            }
                        }
                    } else {
                        if (StringUtils.isNotEmpty(signalExplain)) {
                            signalDictExplain = signalExplain;
                        }
                    }
                    //信号图
                    JSONArray picture = adverseReactionSignal.getJSONArray("picture");
                    Boolean pictureFlag = adverseReactionSignal.getBoolean("pictureFlag");
                    if (CollUtil.isNotEmpty(picture)) {
                        if (pictureFlag) {
                            builderPicture.append("根据信号检测结果，获得 IC 值居前 ").append(picture.size()).append(" 位的信号，即");
                        }
                        StringBuilder dataName = new StringBuilder();
                        for (int i1 = 0; i1 < picture.size(); i1++) {
                            JSONObject jsonObject = picture.getJSONObject(i1);
                            String dataI = jsonObject.getString("i");
                            String dataO = jsonObject.getString("o");
                            if (pictureFlag) {
                                //i检索出来的数据
                                String ror = jsonObject.getString("ror");
                                String ic = jsonObject.getString("ic");
                                builderPicture.append(dataO).append("（ROR=").append(ror).append("，IC=").append(ic).append(") 、");
                                dataName.append(dataO).append("、");
                            } else {
                                //i+o检索出来的数据
                                builderPicture.append("为了考察这").append(dataO).append("这一信号随着时间推移的变化趋势，下图绘制了近3年").append(dataO).append("的时间扫描图谱，详见下图。");
                            }
                            //开始拼接信号图
                            JSONArray x = jsonObject.getJSONArray("x");
                            JSONArray y = jsonObject.getJSONArray("y");
                            JSONArray error = jsonObject.getJSONArray("error");
                            //确定近3年的年份并取近三年的数据
                            int index = 0;
                            List<String> yearList = new ArrayList<>();
                            for (int i2 = 0; i2 < x.size(); i2++) {
                                String strYear = x.getString(i2).substring(0, 4);
                                if (!yearList.contains(strYear)) {
                                    yearList.add(strYear);
                                }
                            }
                            yearList.sort((o1, o2) -> Integer.parseInt(o2) - Integer.parseInt(o1));
                            List<String> threeYears = new ArrayList<>();
                            int range = Integer.min(3, yearList.size());
                            for (int i2 = 0; i2 < range; i2++) {
                                threeYears.add(yearList.get(i2));
                            }
                            for (int i2 = 0; i2 < x.size(); i2++) {
                                String xString = x.getString(i2);
                                if (xString.contains(threeYears.get(threeYears.size() - 1))) {
                                    index = i2;
                                    break;
                                }
                            }
                            JSONObject inner = new JSONObject();
                            String title = "图" + (i1 + 1) + " " + threeYears.get(threeYears.size() - 1) + "-" + threeYears.get(0) + "年" + dataI + "致" + dataO + "的安全信号的时间扫描图";
                            inner.put("title", title);
                            JSONArray newX = new JSONArray();
                            JSONArray newY = new JSONArray();
                            JSONArray newError = new JSONArray();
                            for (int i2 = index; i2 < x.size(); i2++) {
                                newX.add(x.getString(i2));
                            }
                            for (int i2 = index; i2 < y.size(); i2++) {
                                newY.add(y.getString(i2));
                            }
                            for (int i2 = index; i2 < error.size(); i2++) {
                                newError.add(error.getJSONArray(i2));
                            }
                            inner.put("x", newX);
                            inner.put("y", newY);
                            inner.put("error", newError);
                            pictureArr.add(inner);
                        }
                        if (pictureFlag) {
                            builderPicture.append("。").append("为了考察这").append(picture.size()).append("个信号随着时间推移的变化趋势，绘制了近3年").append(dataName.toString(), 0, dataName.toString().length() - 1).append("安全信号的时间扫描图谱，结果见图1").append("~").append(picture.size()).append("。");
                        }
                    } else {
                        if (!pictureFlag) {
                            builderPicture.append(adverseReactionSignal.getString("signalDictExplain"));
                        }
                    }
                }
            }
            if (type != 1) {
                if (!vigi.isEmpty()) {
                    //基本情况数据
                    JSONObject basicInformation = vigi.getJSONObject("basicInformation");
                    if (CollUtil.isNotEmpty(basicInformation)) {
                        //不良反应报告总数
                        allNum = basicInformation.getInteger("allNum");
                        builder21Vigi.append("VigiAccess数据库共获得不良反应报告").append(allNum).append("例。在已知的数据中：");
                        vigi21.append("VigiAccess数据库共获得不良反应报告").append(allNum).append("例。在已知的数据中：");
                        //人群分布
                        JSONObject populationDistribution = basicInformation.getJSONObject("populationDistribution");
                        if (CollUtil.isNotEmpty(populationDistribution)) {
                            //性别
                            JSONArray reportSex = populationDistribution.getJSONArray("reportSex");
                            if (CollUtil.isNotEmpty(reportSex)) {
                                builder21Vigi.append("；");
                                String man = "0%";
                                String woman = "0%";
                                String maxSex = "";
                                int maxSexNum = Integer.MIN_VALUE;
                                for (int i1 = 0; i1 < reportSex.size(); i1++) {
                                    JSONObject json = reportSex.getJSONObject(i1);
                                    String name = json.getString("name");
                                    String num = json.getString("num");
                                    if (!"未知".equals(name)) {
                                        try {
                                            int anInt = Integer.parseInt(num);
                                            if (anInt > maxSexNum) {
                                                maxSexNum = anInt;
                                                maxSex = name;
                                            }
                                        } catch (NumberFormatException e) {
                                            e.printStackTrace();
                                        }
                                    }
                                    String percentage = json.getString("percentage");
                                    if ("男".equals(name)) {
                                        man = percentage;
                                    }
                                    if ("女".equals(name)) {
                                        woman = percentage;
                                    }
                                    JSONObject inner = new JSONObject();
                                    inner.put("name", name);
                                    inner.put("num", num);
                                    inner.put("percentage", percentage);
                                    sexDataVigi.put(name, inner);
                                }
                                builder21Vigi.append("性别构成上，男性（").append(man).append("）").append("男".equals(maxSex) ? "大于" : "小于").append("女性（").append(woman).append("）；");
                                vigi21.append("性别构成上，男性（").append(man).append("）").append("男".equals(maxSex) ? "大于" : "小于").append("女性（").append(woman).append("）；");
                            }
                            //年龄
                            JSONArray reportAge = populationDistribution.getJSONArray("reportAge");
                            if (CollUtil.isNotEmpty(reportAge)) {
                                builder21Vigi.append("；");
                                String maxAge = "";
                                String maxPercentage = "";
                                int maxAgeNum = Integer.MIN_VALUE;
                                for (int i1 = 0; i1 < reportAge.size(); i1++) {
                                    JSONObject json = reportAge.getJSONObject(i1);
                                    String name = json.getString("name");
                                    String num = json.getString("num");
                                    String percentage = json.getString("percentage");
                                    try {
                                        int anInt = Integer.parseInt(num);
                                        if (!"未知".equals(name)) {
                                            if (anInt > maxAgeNum) {
                                                maxAgeNum = anInt;
                                                maxAge = name;
                                                maxPercentage = percentage;
                                            }
                                        }
                                    } catch (NumberFormatException e) {
                                        e.printStackTrace();
                                    }

                                    JSONObject inner = new JSONObject();
                                    inner.put("name", name);
                                    inner.put("num", num);
                                    inner.put("percentage", percentage);
                                    ageDataVigi.put(name, inner);
                                }
                                builder21Vigi.append("年龄主要集中在").append(maxAge).append("（").append(maxPercentage).append("）");
                                vigi21.append("年龄主要集中在").append(maxAge).append("（").append(maxPercentage).append("）；");
                            }
                        }
                        //报告分布
                        JSONObject reportDistribution = basicInformation.getJSONObject("reportDistribution");
                        if (CollUtil.isNotEmpty(reportDistribution)) {
                            //不良反应逐年上报情况
                            JSONArray reportYear = reportDistribution.getJSONArray("reportYear");
                            if (CollUtil.isNotEmpty(reportYear)) {
                                for (int i1 = 0; i1 < reportYear.size(); i1++) {
                                    JSONObject json = reportYear.getJSONObject(i1);
                                    String name = json.getString("name");
                                    String num = json.getString("num");
                                    String percentage = json.getString("percentage");
                                    JSONObject inner = new JSONObject();
                                    inner.put("name", name);
                                    inner.put("num", num);
                                    inner.put("percentage", percentage);
                                    reportYearDataVigi.put(name, inner);
                                }
                            }
                            //地区分布
                            JSONArray reportCountry = reportDistribution.getJSONArray("reportCountry");
                            if (CollUtil.isNotEmpty(reportCountry)) {
                                int maxIntCountry = Integer.MIN_VALUE;
                                builder21Vigi.append("；");
                                String maxCountry = "";
                                String asiaNum = "";
                                for (int i1 = 0; i1 < reportCountry.size(); i1++) {
                                    JSONObject json = reportCountry.getJSONObject(i1);
                                    String name = json.getString("name");
                                    String num = json.getString("num");
                                    if ("亚洲".equals(name)) {
                                        asiaNum = num;
                                    }
                                    try {
                                        int anInt = Integer.parseInt(num);
                                        if (!"未知".equals(maxCountry)) {
                                            if (anInt > maxIntCountry) {
                                                maxIntCountry = anInt;
                                                maxCountry = name;
                                            }
                                        }
                                    } catch (NumberFormatException e) {
                                        e.printStackTrace();
                                    }
                                    String percentage = json.getString("percentage");
                                    JSONObject inner = new JSONObject();
                                    inner.put("name", name);
                                    inner.put("num", num);
                                    inner.put("percentage", percentage);
                                    countryDataVigi.put(name, inner);
                                }
                                builder21Vigi.append(maxCountry).append("报告数最多").append("，亚洲的报告数有").append(asiaNum).append("份");
                                vigi21.append(maxCountry).append("报告数最多").append("，亚洲的报告数有").append(asiaNum).append("份；");
                            }
                        }
                    }
                    //严重不良反应分布
                    JSONObject outcomeAnalysis = vigi.getJSONObject("outcomeAnalysis");
                    if (CollUtil.isNotEmpty(outcomeAnalysis)) {
                        JSONArray adverseReactions = outcomeAnalysis.getJSONArray("adverseReactions");
                        if (CollUtil.isNotEmpty(adverseReactions)) {
                            builder21Vigi.append("；");
                            String maxOccupation = adverseReactions.getJSONObject(0).getString("name");
                            String maxNum = adverseReactions.getJSONObject(0).getString("num");
                            String maxPercentage = adverseReactions.getJSONObject(0).getString("percentage");
                            for (int i1 = 0; i1 < adverseReactions.size(); i1++) {
                                JSONObject json = adverseReactions.getJSONObject(i1);
                                String name = json.getString("name");
                                String num = json.getString("num");
                                String percentage = json.getString("percentage");
                                JSONObject inner = new JSONObject();
                                inner.put("name", name);
                                inner.put("num", num);
                                inner.put("percentage", percentage);
                                adverseReactionsDataVigi.put(name, inner);
                            }
                            builder21Vigi.append(originalI).append(" 严重不良反应结局中以").append(maxOccupation).append("报告数最多（").append(maxNum).append("例，").append(maxPercentage).append("）");
                            vigi21.append(originalI).append(" 严重不良反应结局中以").append(maxOccupation).append("报告数最多（").append(maxNum).append("例，").append(maxPercentage).append("）。");
                        }
                    }
                    builder21Vigi.append("。").append("其人口学特征及严重不良事件构成情况见表 1。不良反应逐年上报情况详见表 2。");
                    //不良反应及信号分析 adverseReactionSignal
                    JSONObject adverseReactionSignal = vigi.getJSONObject("adverseReactionSignal");
                    if (CollUtil.isNotEmpty(adverseReactionSignal)) {
                        //不良反应分析 pt
                        JSONArray pt = adverseReactionSignal.getJSONArray("pt");
                        if (CollUtil.isNotEmpty(pt)) {
                            builder31Vigi.append("VigiAccess数据库显示：在").append(originalI).append("相关的").append(allNum).append("份 ADEs 报告中，表 8列出了报告前 50 位的ADEs，包括");
                            vigi31.append("在").append(originalI).append("相关的").append(allNum).append("份 ADEs 报告中，列出了报告前 20 位的ADEs，包括");
                            int range = 5;
                            if (pt.size() < 5) {
                                range = pt.size();
                            }
                            Map<String, Integer> onlyMap = new HashMap<>();
                            for (int i1 = 0; i1 < pt.size(); i1++) {
                                JSONObject ptJSONObject = pt.getJSONObject(i1);
                                String englishName = ptJSONObject.getString("englishName");
                                String name = ptJSONObject.getString("name");
                                String num = ptJSONObject.getString("num");
                                String percentage = ptJSONObject.getString("percentage");
                                String diseaseType = ptJSONObject.getString("diseaseType");
                                if (onlyMap.containsKey(diseaseType)) {
                                    onlyMap.put(diseaseType, onlyMap.get(diseaseType) + 1);
                                } else {
                                    onlyMap.put(diseaseType, 1);
                                }
                                if (i1 < range) {
                                    if (i1 == range - 2) {
                                        builder31Vigi.append(name).append("和");
                                        vigi31.append(name).append("和");
                                    } else if (i1 == range - 1) {
                                        builder31Vigi.append(name).append("等");
                                        vigi31.append(name).append("等");
                                    } else {
                                        builder31Vigi.append(name).append("、");
                                        vigi31.append(name).append("、");
                                    }
                                }
                                List<String> inner = Arrays.asList(englishName, name, num, percentage);
                                ptVigiList.add(inner);
                            }
                            builder31Vigi.append("，涉及");
                            vigi31.append("，涉及");
                            int range2 = 5;
                            if (onlyMap.size() < 5) {
                                range2 = onlyMap.size();
                            }
                            int index = 0;
                            Set<Map.Entry<String, Integer>> entries = onlyMap.entrySet();
                            for (Map.Entry<String, Integer> entry : entries) {
                                if (index >= range2) {
                                    break;
                                }
                                String key = entry.getKey();
                                if (index == range2 - 2) {
                                    builder31Vigi.append(key).append("和");
                                    vigi31.append(key).append("和");
                                } else if (index == range2 - 1) {
                                    builder31Vigi.append(key).append("等");
                                    vigi31.append(key).append("等");
                                } else {
                                    builder31Vigi.append(key).append("、");
                                    vigi31.append(key).append("、");
                                }
                                index++;
                            }
                            builder31Vigi.append("系统。");
                            vigi31.append("系统。");
                        }
                        //各系统器官分类的ADR信号数及ADEs报告数 signalDict
                        JSONArray signalDict = adverseReactionSignal.getJSONArray("signalDict");
                        if (CollUtil.isNotEmpty(signalDict)) {
                            int signalDictTypeCount = adverseReactionSignal.getInteger("signalDictTypeCount");
                            int signalDictNumCount = adverseReactionSignal.getInteger("signalDictNumCount");
                            builder32Vigi.append("VigiAccess数据库共获得 ").append(signalDictNumCount).append("个有信号的ADEs，共涉及").append(signalDictTypeCount).append("个SOC。使用国际医学用语词典（MedDRA）术语集系统器官分类（system organ class,SOC）对有信号的ADEs 进行分类。表 10为TOP50的信号以及信号所在的系统-器官情况。");
                            vigi32.append("VigiAccess数据库共获得 ").append(signalDictNumCount).append("个有信号的ADEs，共涉及").append(signalDictTypeCount).append("个SOC。使用国际医学用语词典（MedDRA）术语集系统器官分类（system organ class,SOC）对有信号的ADEs 进行分类。");
                            for (int i1 = 0; i1 < signalDict.size(); i1++) {
                                JSONObject dictJSONObject = signalDict.getJSONObject(i1);
                                String outEnglishName = dictJSONObject.getString("outEnglishName");
                                String englishName = dictJSONObject.getString("englishName");
                                String name = dictJSONObject.getString("name");
                                String num = dictJSONObject.getString("num");
                                String outName = dictJSONObject.getString("outName");
                                String ror = dictJSONObject.getString("ror");
                                String ebgm = dictJSONObject.getString("ebgm");
                                String ic = dictJSONObject.getString("ic");
                                //取外层key全称
                                if (!signalDictVigiOnlyMap.containsKey(outName)) {
                                    signalDictVigiOnlyMap.put(outName, outEnglishName);
                                }
                                if (signalDictVigiMap.containsKey(outName)) {
                                    List<List<String>> lists = signalDictVigiMap.get(outName);
                                    lists.add(Arrays.asList(englishName, name, num, ror, ebgm, ic));
                                } else {
                                    List<List<String>> lists = new ArrayList<>();
                                    lists.add(Arrays.asList(englishName, name, num, ror, ebgm, ic));
                                    signalDictVigiMap.put(outName, lists);
                                }
                            }
                        }
                    }
                }
            }
        }

        //一、循证方法
        com.lowagie.text.Paragraph title1 = createHeadWord(14, "一、循证方法", Element.ALIGN_LEFT);
        document.add(title1);
        //1.1 检索策略
        com.lowagie.text.Paragraph title11 = createHeadWord(14, "1.1 检索策略", Element.ALIGN_LEFT);
        document.add(title11);
        //添加正文
        if (StringUtils.isNotEmpty(originalI)) {
            if (!originalI.equals(i)) {
                com.lowagie.text.Paragraph paragraphData1 = createDataWord("药品名称: " + originalI + "/" + i);
                paragraphData1.setFirstLineIndent(25);
                document.add(paragraphData1);
            } else {
                com.lowagie.text.Paragraph paragraphData1 = createDataWord("药品名称: " + originalI);
                paragraphData1.setFirstLineIndent(25);
                document.add(paragraphData1);
            }
        }
        if (StringUtils.isNotEmpty(originalO)) {
            if (!originalO.equals(o)) {
                com.lowagie.text.Paragraph paragraphData2 = createDataWord("不良反应: " + originalO + "/" + o);
                paragraphData2.setFirstLineIndent(25);
                document.add(paragraphData2);
            } else {
                com.lowagie.text.Paragraph paragraphData2 = createDataWord("不良反应: " + originalO);
                paragraphData2.setFirstLineIndent(25);
                document.add(paragraphData2);
            }
        }
        com.lowagie.text.Paragraph paragraphData3 = createDataWord("检索范围: FAERS不良反应数据库、VigiAccess数据库");
        paragraphData3.setFirstLineIndent(25);
        document.add(paragraphData3);
        com.lowagie.text.Paragraph paragraphData4 = createDataWord("检索时间: FAERS数据库（建库-2023.03.31）、VigiAccess数据库（建库-2022.09.14）");
        paragraphData4.setFirstLineIndent(25);
        document.add(paragraphData4);
        com.lowagie.text.Paragraph paragraphData5 = createDataWord("方法学内容详见附录。");
        paragraphData5.setFirstLineIndent(25);
        document.add(paragraphData5);

        //二、循证结果
        com.lowagie.text.Paragraph title2 = createHeadWord(14, "二、循证结果", Element.ALIGN_LEFT);
        title2.setSpacingAfter(10);
        title2.setSpacingBefore(10);
        document.add(title2);

        //分析综述
        com.lowagie.text.Paragraph mainData = createDataWord("基于您的检索词：" + conditionData);
        mainData.setFirstLineIndent(25);
        document.add(mainData);
        if (!analysisOverview.isEmpty()) {
            JSONArray analysisList = analysisOverview.getJSONArray("list");
            if (CollUtil.isNotEmpty(analysisList)) {
                for (int i1 = 0; i1 < analysisList.size(); i1++) {
                    String string = analysisList.getString(i1);
                    //对获得的分析综述进行处理
                    if (string.contains("基于您的检索词")) {
                        continue;
                    }
                    //去除span标签
                    //string = string.replaceAll("<span>", "").replaceAll("</span>", "");
                    com.lowagie.text.Paragraph inner = createDataWord(string);
                    inner.setFirstLineIndent(25);
                    document.add(inner);
                }
            }
        }

        //2.1 基本情况
        com.lowagie.text.Paragraph title21 = createHeadWord(14, "2 .1  基本情况", Element.ALIGN_LEFT);
        title21.setSpacingAfter(10);
        title21.setSpacingBefore(10);
        document.add(title21);
        //开始合并基础数据
        int flagFda211 = 0;
        int flagVigi211 = 0;
        //性别
        List<List<String>> sexList = new ArrayList<>();
        //年龄
        List<List<String>> ageList = new ArrayList<>();
        //报告国家
        List<List<String>> countryList = new ArrayList<>();
        //职业
        List<List<String>> reportList = new ArrayList<>();
        //不良反应逐年上报情况
        List<List<String>> reportYear = new ArrayList<>();
        //严重不良反应
        List<List<String>> adverseReactionsList = new ArrayList<>();
        //表1列数
        int tableNum1 = 0;
        if (CollUtil.isNotEmpty(sexDataFda) || CollUtil.isNotEmpty(ageDataFda) || CollUtil.isNotEmpty(countryDataFda) || CollUtil.isNotEmpty(reportDataFda)) {
            flagFda211 = 1;
        }
        if (CollUtil.isNotEmpty(sexDataVigi) || CollUtil.isNotEmpty(ageDataVigi) || CollUtil.isNotEmpty(countryDataVigi)) {
            flagVigi211 = 1;
        }
        if (flagFda211 == 1 && flagVigi211 == 1) {
            tableNum1 = 5;
            //性别
            if (CollUtil.isNotEmpty(sexDataFda) && CollUtil.isNotEmpty(sexDataVigi)) {
                Set<String> keySet = new HashSet<>();
                Set<String> fdaSet = sexDataFda.keySet();
                Set<String> vigiSet = sexDataVigi.keySet();
                keySet.addAll(fdaSet);
                keySet.addAll(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = sexDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    //vigi
                    JSONObject vigiJSONObject = sexDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    sexList.add(inner);
                }
            }
            //年龄
            if (CollUtil.isNotEmpty(ageDataFda) && CollUtil.isNotEmpty(ageDataVigi)) {
                Set<String> keySet = new HashSet<>();
                Set<String> fdaSet = ageDataFda.keySet();
                Set<String> vigiSet = ageDataVigi.keySet();
                keySet.addAll(fdaSet);
                keySet.addAll(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = ageDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    //vigi
                    JSONObject vigiJSONObject = ageDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    ageList.add(inner);
                }
            }
            //报告国家
            if (CollUtil.isNotEmpty(countryDataFda) && CollUtil.isNotEmpty(countryDataVigi)) {
                Set<String> keySet = new HashSet<>();
                Set<String> fdaSet = countryDataFda.keySet();
                Set<String> vigiSet = countryDataVigi.keySet();
                keySet.addAll(fdaSet);
                keySet.addAll(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = countryDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    //vigi
                    JSONObject vigiJSONObject = countryDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    countryList.add(inner);
                }
            }
            //职业
            if (CollUtil.isNotEmpty(reportDataFda)) {
                Set<String> fdaSet = reportDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = reportDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    //vigi
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    reportList.add(inner);
                }
            }
            //严重不良反应
            if (CollUtil.isNotEmpty(adverseReactionsDataFda) || CollUtil.isNotEmpty(adverseReactionsDataVigi)) {
                Set<String> keySet = new HashSet<>();
                Set<String> fdaSet = adverseReactionsDataFda.keySet();
                Set<String> vigiSet = adverseReactionsDataVigi.keySet();
                keySet.addAll(fdaSet);
                keySet.addAll(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = adverseReactionsDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    //vigi
                    JSONObject vigiJSONObject = adverseReactionsDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    adverseReactionsList.add(inner);
                }
            }
        } else if (flagFda211 == 1) {
            tableNum1 = 3;
            //性别
            if (CollUtil.isNotEmpty(sexDataFda)) {
                Set<String> fdaSet = sexDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = sexDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    sexList.add(inner);
                }
            }
            //年龄
            if (CollUtil.isNotEmpty(ageDataFda)) {
                Set<String> fdaSet = ageDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = ageDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    ageList.add(inner);
                }
            }
            //报告国家
            if (CollUtil.isNotEmpty(countryDataFda)) {
                Set<String> fdaSet = countryDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = countryDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    countryList.add(inner);
                }
            }
            //职业
            if (CollUtil.isNotEmpty(reportDataFda)) {
                Set<String> fdaSet = reportDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = reportDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    reportList.add(inner);
                }
            }
            //严重不良反应
            if (CollUtil.isNotEmpty(adverseReactionsDataFda)) {
                Set<String> fdaSet = adverseReactionsDataFda.keySet();
                Set<String> keySet = new HashSet<>(fdaSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //fda
                    JSONObject fdaJSONObject = adverseReactionsDataFda.getJSONObject(s);
                    String fdaNum = "-";
                    String fdaPercentage = "-";
                    if (CollUtil.isNotEmpty(fdaJSONObject)) {
                        fdaNum = fdaJSONObject.getString("num");
                        fdaPercentage = fdaJSONObject.getString("percentage");
                    }
                    inner.add(fdaNum);
                    inner.add(fdaPercentage);
                    adverseReactionsList.add(inner);
                }
            }
        } else if (flagVigi211 == 1) {
            tableNum1 = 3;
            //性别
            if (CollUtil.isNotEmpty(sexDataVigi)) {
                Set<String> vigiSet = sexDataVigi.keySet();
                Set<String> keySet = new HashSet<>(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //vigi
                    JSONObject vigiJSONObject = sexDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    sexList.add(inner);
                }
            }
            //年龄
            if (CollUtil.isNotEmpty(ageDataVigi)) {
                Set<String> vigiSet = ageDataVigi.keySet();
                Set<String> keySet = new HashSet<>(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //vigi
                    JSONObject vigiJSONObject = ageDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    ageList.add(inner);
                }
            }
            //报告国家
            if (CollUtil.isNotEmpty(countryDataVigi)) {
                Set<String> vigiSet = countryDataVigi.keySet();
                Set<String> keySet = new HashSet<>(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //vigi
                    JSONObject vigiJSONObject = countryDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    countryList.add(inner);
                }
            }
            //严重不良反应
            if (CollUtil.isNotEmpty(adverseReactionsDataVigi)) {
                Set<String> vigiSet = adverseReactionsDataVigi.keySet();
                Set<String> keySet = new HashSet<>(vigiSet);
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    //vigi
                    JSONObject vigiJSONObject = adverseReactionsDataVigi.getJSONObject(s);
                    String vigiNum = "-";
                    String vigiPercentage = "-";
                    if (CollUtil.isNotEmpty(vigiJSONObject)) {
                        vigiNum = vigiJSONObject.getString("num");
                        vigiPercentage = vigiJSONObject.getString("percentage");
                    }
                    inner.add(vigiNum);
                    inner.add(vigiPercentage);
                    adverseReactionsList.add(inner);
                }
            }
        }

        //表2列数
        int tableNum2;
        int flagFda212 = 0;
        int flagVigi212 = 0;
        if (CollUtil.isNotEmpty(reportYearDataFda)) {
            flagFda212 = 1;
        }
        if (CollUtil.isNotEmpty(reportYearDataVigi)) {
            flagVigi212 = 1;
        }
        if (flagFda212 == 1 && flagVigi212 == 1) {
            tableNum2 = 3;
            Set<String> keySet = new HashSet<>();
            Set<String> fdaSet = reportYearDataFda.keySet();
            Set<String> vigiSet = reportYearDataVigi.keySet();
            keySet.addAll(fdaSet);
            keySet.addAll(vigiSet);
            List<String> keyList = new ArrayList<>(keySet);
            Collections.sort(keyList);
            for (String s : keyList) {
                List<String> inner = new ArrayList<>();
                inner.add(s);
                //fda
                JSONObject fdaJSONObject = reportYearDataFda.getJSONObject(s);
                String fdaNum = "-";
                //String fdaPercentage = "-";
                if (CollUtil.isNotEmpty(fdaJSONObject)) {
                    fdaNum = fdaJSONObject.getString("num");
                    //fdaPercentage = fdaJSONObject.getString("percentage");
                }
                inner.add(fdaNum);
                //inner.add(fdaPercentage);
                //vigi
                JSONObject vigiJSONObject = reportYearDataVigi.getJSONObject(s);
                String vigiNum = "-";
                //String vigiPercentage = "-";
                if (CollUtil.isNotEmpty(vigiJSONObject)) {
                    vigiNum = vigiJSONObject.getString("num");
                    //vigiPercentage = vigiJSONObject.getString("percentage");
                }
                inner.add(vigiNum);
                //inner.add(vigiPercentage);
                reportYear.add(inner);
            }
        } else if (flagFda212 == 1) {
            tableNum2 = 2;
            Set<String> fdaSet = reportYearDataFda.keySet();
            Set<String> keySet = new HashSet<>(fdaSet);
            List<String> keyList = new ArrayList<>(keySet);
            Collections.sort(keyList);
            for (String s : keyList) {
                List<String> inner = new ArrayList<>();
                inner.add(s);
                //fda
                JSONObject fdaJSONObject = reportYearDataFda.getJSONObject(s);
                String fdaNum = "-";
                //String fdaPercentage = "-";
                if (CollUtil.isNotEmpty(fdaJSONObject)) {
                    fdaNum = fdaJSONObject.getString("num");
                    //fdaPercentage = fdaJSONObject.getString("percentage");
                }
                inner.add(fdaNum);
                //inner.add(fdaPercentage);
                reportYear.add(inner);
            }
        } else {
            tableNum2 = 2;
            Set<String> vigiSet = reportYearDataVigi.keySet();
            Set<String> keySet = new HashSet<>(vigiSet);
            List<String> keyList = new ArrayList<>(keySet);
            Collections.sort(keyList);
            for (String s : keyList) {
                List<String> inner = new ArrayList<>();
                inner.add(s);
                //vigi
                JSONObject vigiJSONObject = reportYearDataVigi.getJSONObject(s);
                String vigiNum = "-";
                //String vigiPercentage = "-";
                if (CollUtil.isNotEmpty(vigiJSONObject)) {
                    vigiNum = vigiJSONObject.getString("num");
                    // vigiPercentage = vigiJSONObject.getString("percentage");
                }
                inner.add(vigiNum);
                //inner.add(vigiPercentage);
                reportYear.add(inner);
            }
        }

        //***************创建表格1***********************
        Table table1 = new Table(tableNum1);
        List<String> nameList1;
        if (flagFda211 == 1 && flagVigi211 == 1) {
            //2.1 fda说明
            String replaceAll1 = builder21Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph data1 = createDataWord(replaceAll1);
            data1.setFirstLineIndent(25);
            document.add(data1);

            String replaceAll2 = builder21Vigi.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph data2 = createDataWord(replaceAll2);
            data2.setFirstLineIndent(25);
            document.add(data2);

            nameList1 = Arrays.asList("信息/类别", "FAERS数据库", "VigiAccess数据库", "报告例数", "构成比", "报告例数", "构成比");
        } else if (flagFda211 == 1) {
            String replaceAll1 = builder21Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph data1 = createDataWord(replaceAll1);
            data1.setFirstLineIndent(25);
            document.add(data1);

            nameList1 = Arrays.asList("信息/类别", "FAERS数据库", "报告例数", "占比");
        } else {
            //2.1 vigi说明
            String replaceAll2 = builder21Vigi.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph data2 = createDataWord(replaceAll2);
            data2.setFirstLineIndent(25);
            document.add(data2);

            nameList1 = Arrays.asList("信息/类别", "VigiAccess数据库", "报告例数", "占比");
        }
        com.lowagie.text.Paragraph paragraphTable1Head;
        //开始创建表
        if (type == 1) {
            paragraphTable1Head = createHeadWord(14, "表1  " + originalI + "致" + originalO + "的人口学特征及严重不良事件构成情况", Element.ALIGN_CENTER);
        } else {
            paragraphTable1Head = createHeadWord(14, "表1  " + originalI + "的人口学特征及严重不良事件构成情况", Element.ALIGN_CENTER);
        }
        //设置段落前后间距
        paragraphTable1Head.setSpacingAfter(10);
        paragraphTable1Head.setSpacingBefore(10);
        document.add(paragraphTable1Head);
        //table1设置表格标题
        com.lowagie.text.Font font = createFontWord(14, Font.NORMAL);
        for (String s : nameList1) {
            Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
            if ("信息/类别".equals(s)) {
                cell.setRowspan(2);
            }
            if ("FAERS数据库".equals(s) || "VigiAccess数据库".equals(s)) {
                cell.setColspan(2);
            }
            cell.setBackgroundColor(new Color(221, 221, 221));
            cell.setUseAscender(true);
            cell.setHorizontalAlignment(Element.ALIGN_CENTER);
            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
            table1.addCell(cell);
        }
        //table1设置表格内容
        //性别 + 年龄段/岁 + 报告国家 + 上报者职业 + 严重不良事件
        Map<String, List<List<String>>> dataMap1 = new LinkedHashMap<>();
        if (CollUtil.isNotEmpty(sexList)) {
            dataMap1.put("性别", sexList);
        }
        if (CollUtil.isNotEmpty(ageList)) {
            dataMap1.put("年龄段/岁", ageList);
        }
        if (CollUtil.isNotEmpty(countryList)) {
            dataMap1.put("报告国家", countryList);
        }
        if (CollUtil.isNotEmpty(reportList)) {
            dataMap1.put("上报者职业", reportList);
        }
        if (CollUtil.isNotEmpty(adverseReactionsList)) {
            dataMap1.put("严重不良事件", adverseReactionsList);
        }
        //标题加粗
        com.lowagie.text.Font fontTitle = createFontWord(14, Font.BOLD);
        Set<Map.Entry<String, List<List<String>>>> entries1 = dataMap1.entrySet();
        for (Map.Entry<String, List<List<String>>> entry : entries1) {
            String key = entry.getKey();
            List<List<String>> value = entry.getValue();
            Cell cell = new Cell(new com.lowagie.text.Phrase(key, fontTitle));
            cell.setUseAscender(true);
            cell.setHorizontalAlignment(Element.ALIGN_LEFT);
            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
            table1.addCell(cell);
            Cell cellSpace = new Cell(new com.lowagie.text.Phrase("", font));
            for (int i1 = 0; i1 < tableNum1 - 1; i1++) {
                table1.addCell(cellSpace);
            }
            for (List<String> list : value) {
                for (String s : list) {
                    table1.addCell(createTableContentWord(s));
                }
            }
        }
        document.add(table1);

        //****************创建表格2*********************
        Table table2 = new Table(tableNum2);
        List<String> nameList2;
        if (flagFda211 == 1 && flagVigi211 == 1) {
            nameList2 = Arrays.asList("年份", "不良反应报告数量（份）", "FAERS数据库", "VigiAccess数据库");
        } else if (flagFda211 == 1) {
            nameList2 = Arrays.asList("年份", "不良反应报告数量（份）", "FAERS数据库");
        } else {
            nameList2 = Arrays.asList("年份", "不良反应报告数量（份）", "VigiAccess数据库");
        }
        com.lowagie.text.Paragraph paragraphTable2Head;
        //开始创建表
        if (type == 1) {
            paragraphTable2Head = createHeadWord(14, "表2  不良反应逐年上报情况", Element.ALIGN_CENTER);
        } else {
            paragraphTable2Head = createHeadWord(14, "表2  不良反应逐年上报情况", Element.ALIGN_CENTER);
        }
        //设置段落前后间距
        paragraphTable2Head.setSpacingAfter(10);
        paragraphTable2Head.setSpacingBefore(10);
        document.add(paragraphTable2Head);
        //table2设置表格标题
        for (String s : nameList2) {
            Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
            if ("年份".equals(s)) {
                cell.setRowspan(2);
            }
            if (flagFda212 == 1 && flagVigi212 == 1 && "不良反应报告数量（份）".equals(s)) {
                cell.setColspan(2);
            }
            cell.setBackgroundColor(new Color(221, 221, 221));
            cell.setUseAscender(true);
            cell.setHorizontalAlignment(Element.ALIGN_CENTER);
            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
            table2.addCell(cell);
        }
        //table2设置表格内容
        for (List<String> list : reportYear) {
            for (String s : list) {
                table2.addCell(createTableContentWord(s));
            }
        }
        document.add(table2);


        //2.2 用药情况分析
        com.lowagie.text.Paragraph title22 = createHeadWord(14, "2 .2  用药情况分析", Element.ALIGN_LEFT);
        title22.setSpacingAfter(10);
        title22.setSpacingBefore(10);
        document.add(title22);

        //剂型
        List<List<String>> doseFormList = new ArrayList<>();
        //给药途径
        List<List<String>> routeList = new ArrayList<>();
        //给药剂量
        List<List<String>> doseAmtList = new ArrayList<>();
        //持续用药时间
        List<List<String>> durTimeList = new ArrayList<>();
        //表3列数
        int tableNum3 = 3;
        //数据处理
        if (CollUtil.isNotEmpty(doseFormDataFda) || CollUtil.isNotEmpty(routeDataFda) || CollUtil.isNotEmpty(doseAmtDataFda) || CollUtil.isNotEmpty(durTimeDataFda)) {
            //剂型
            if (CollUtil.isNotEmpty(doseFormDataFda)) {
                Set<String> keySet = new HashSet<>(doseFormDataFda.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = doseFormDataFda.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    doseFormList.add(inner);
                }
            }
            //给药途径
            if (CollUtil.isNotEmpty(routeDataFda)) {
                Set<String> keySet = new HashSet<>(routeDataFda.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = routeDataFda.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    routeList.add(inner);
                }
            }
            //给药剂量
            if (CollUtil.isNotEmpty(doseAmtDataFda)) {
                Set<String> keySet = new HashSet<>(doseAmtDataFda.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = doseAmtDataFda.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    doseAmtList.add(inner);
                }
            }
            //持续用药时间
            if (CollUtil.isNotEmpty(durTimeDataFda)) {
                Set<String> keySet = new HashSet<>(durTimeDataFda.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = durTimeDataFda.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    durTimeList.add(inner);
                }
            }

            //2.2说明
            String replaceAll22 = builder22Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph data22 = createDataWord(replaceAll22);
            data22.setFirstLineIndent(25);
            document.add(data22);
            //***************创建表格3***********************
            Table table3 = new Table(tableNum3);
            //开始创建表
            com.lowagie.text.Paragraph paragraphTable22Head;
            if (type == 1) {
                paragraphTable22Head = createHeadWord(14, "表3  用药情况", Element.ALIGN_CENTER);
            } else {
                paragraphTable22Head = createHeadWord(14, "表3  用药情况", Element.ALIGN_CENTER);
            }
            //设置段落前后间距
            paragraphTable22Head.setSpacingAfter(10);
            paragraphTable22Head.setSpacingBefore(10);
            document.add(paragraphTable22Head);
            //开始创建table3表头
            List<String> nameList3 = Arrays.asList("影响因素", "报告例数", "占比");
            for (String s : nameList3) {
                Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
                cell.setBackgroundColor(new Color(221, 221, 221));
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table3.addCell(cell);
            }
            //table3设置表格内容
            //剂型 + 给药途径 + 给药剂量 + 持续用药时间
            Map<String, List<List<String>>> dataMap3 = new LinkedHashMap<>();
            if (CollUtil.isNotEmpty(doseFormList)) {
                dataMap3.put("剂型", doseFormList);
            }
            if (CollUtil.isNotEmpty(routeList)) {
                dataMap3.put("给药途径", routeList);
            }
            if (CollUtil.isNotEmpty(doseAmtList)) {
                dataMap3.put("给药剂量", doseAmtList);
            }
            if (CollUtil.isNotEmpty(durTimeList)) {
                dataMap3.put("持续用药时间", durTimeList);
            }
            Set<Map.Entry<String, List<List<String>>>> entries3 = dataMap3.entrySet();
            for (Map.Entry<String, List<List<String>>> entry : entries3) {
                String key = entry.getKey();
                List<List<String>> value = entry.getValue();
                Cell cell = new Cell(new com.lowagie.text.Phrase(key, fontTitle));
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_LEFT);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table3.addCell(cell);
                Cell cellSpace = new Cell(new com.lowagie.text.Phrase("", font));
                for (int i1 = 0; i1 < tableNum3 - 1; i1++) {
                    table3.addCell(cellSpace);
                }
                for (List<String> list : value) {
                    for (String s : list) {
                        table3.addCell(createTableContentWord(s));
                    }
                }
            }
            document.add(table3);
            com.lowagie.text.Paragraph tableTitle = createDataTypeWord(10, "注释：持续用药时间=结束用药时间-开始用药时间", Font.NORMAL);
            document.add(tableTitle);
        }

        //2.3 用药适应征分析
        com.lowagie.text.Paragraph title23 = createHeadWord(14, "2 .3  用药适应征分析", Element.ALIGN_LEFT);
        title23.setSpacingAfter(10);
        title23.setSpacingBefore(10);
        document.add(title23);
        if (CollUtil.isNotEmpty(indiPtList)) {
            //2.3 用药适应征分析说明
            String replaceAll23 = builder23Fda.toString().replaceAll("，。", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph data23 = createDataWord(replaceAll23);
            data23.setFirstLineIndent(25);
            document.add(data23);
            //开始创建表4
            Table table4 = new Table(3);
            com.lowagie.text.Paragraph paragraphTable4Head = createHeadWord(14, "表4  用药适应症分布情况", Element.ALIGN_CENTER);
            //设置段落前后间距
            paragraphTable4Head.setSpacingAfter(10);
            paragraphTable4Head.setSpacingBefore(10);
            document.add(paragraphTable4Head);
            //table4设置表格标题
            List<String> nameList4 = Arrays.asList("用药适应症", "例数", "占比");
            for (String s : nameList4) {
                Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
                cell.setBackgroundColor(new Color(221, 221, 221));
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table4.addCell(cell);
            }
            for (List<String> list : indiPtList) {
                for (String s : list) {
                    table4.addCell(createTableContentWord(s));
                }
            }
            document.add(table4);
        }

        //2.4 给药方案及不良反应发生时间分布
        com.lowagie.text.Paragraph title24 = createHeadWord(14, "2 .4  给药方案及不良反应发生时间分布", Element.ALIGN_LEFT);
        title24.setSpacingAfter(10);
        title24.setSpacingBefore(10);
        document.add(title24);
        if (CollUtil.isNotEmpty(drugNumData) || CollUtil.isNotEmpty(cutDtTimeData)) {
            String replaceAll24 = builder24Fda.append("详见表 5。").toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph data24 = createDataWord(replaceAll24);
            data24.setFirstLineIndent(25);
            document.add(data24);
            //给药方案
            List<List<String>> drugNumList = new ArrayList<>();
            if (CollUtil.isNotEmpty(drugNumData)) {
                Set<String> keySet = new HashSet<>(drugNumData.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = drugNumData.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    drugNumList.add(inner);
                }
            }
            //不良反应发生时间
            List<List<String>> cutDtTimeList = new ArrayList<>();
            if (CollUtil.isNotEmpty(cutDtTimeData)) {
                Set<String> keySet = new HashSet<>(cutDtTimeData.keySet());
                for (String s : keySet) {
                    List<String> inner = new ArrayList<>();
                    inner.add(s);
                    JSONObject jsonObject = cutDtTimeData.getJSONObject(s);
                    String num = jsonObject.getString("num");
                    String percentage = jsonObject.getString("percentage");
                    inner.add(num);
                    inner.add(percentage);
                    cutDtTimeList.add(inner);
                }
            }
            //***************创建表格5***********************
            Table table5 = new Table(3);
            //开始创建表
            com.lowagie.text.Paragraph paragraphTable24Head = createHeadWord(14, "表5  给药方案、不良反应发生时间分布", Element.ALIGN_CENTER);
            //设置段落前后间距
            paragraphTable24Head.setSpacingAfter(10);
            paragraphTable24Head.setSpacingBefore(10);
            document.add(paragraphTable24Head);
            //开始创建table3表头
            List<String> nameList3 = Arrays.asList("影响因素", "报告例数", "占比");
            for (String s : nameList3) {
                Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
                cell.setBackgroundColor(new Color(221, 221, 221));
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table5.addCell(cell);
            }
            //table3设置表格内容
            //给药方案 + 不良反应发生时间
            Map<String, List<List<String>>> dataMap5 = new LinkedHashMap<>();
            if (CollUtil.isNotEmpty(drugNumList)) {
                dataMap5.put("给药方案", drugNumList);
            }
            if (CollUtil.isNotEmpty(cutDtTimeList)) {
                dataMap5.put("不良反应发生时间", cutDtTimeList);
            }
            Set<Map.Entry<String, List<List<String>>>> entries5 = dataMap5.entrySet();
            for (Map.Entry<String, List<List<String>>> entry : entries5) {
                String key = entry.getKey();
                List<List<String>> value = entry.getValue();
                Cell cell = new Cell(new com.lowagie.text.Phrase(key, fontTitle));
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_LEFT);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table5.addCell(cell);
                Cell cellSpace = new Cell(new com.lowagie.text.Phrase("", font));
                for (int i1 = 0; i1 < 2; i1++) {
                    table5.addCell(cellSpace);
                }
                for (List<String> list : value) {
                    for (String s : list) {
                        table5.addCell(createTableContentWord(s));
                    }
                }
            }
            document.add(table5);
            com.lowagie.text.Paragraph tableTitle = createDataTypeWord(10, "注释：不良反应发生时间：用药后首次出现不良反应的时间段。", Font.NORMAL);
            document.add(tableTitle);
        }

        //2.5 治疗与转归
        com.lowagie.text.Paragraph title25 = createHeadWord(14, "2 .5  治疗与转归", Element.ALIGN_LEFT);
        title25.setSpacingAfter(10);
        title25.setSpacingBefore(10);
        document.add(title25);
        if (CollUtil.isNotEmpty(dechalAndRechalMap)) {
            String replaceAll25 = builder25Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph data25 = createDataWord(replaceAll25);
            data25.setFirstLineIndent(25);
            document.add(data25);
            //治疗与转归
            //开始创建表6
            Table table6 = new Table(4);
            com.lowagie.text.Paragraph paragraphTable6Head = createHeadWord(14, "表6 治疗与转归", Element.ALIGN_CENTER);
            //设置段落前后间距
            paragraphTable6Head.setSpacingAfter(10);
            paragraphTable6Head.setSpacingBefore(10);
            document.add(paragraphTable6Head);
            //table6设置表格标题
            List<String> nameList6 = Arrays.asList("治疗与转归", "结果", "例数", "占比");
            for (String s : nameList6) {
                Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
                cell.setBackgroundColor(new Color(221, 221, 221));
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table6.addCell(cell);
            }
            Set<Map.Entry<String, List<List<String>>>> entries = dechalAndRechalMap.entrySet();
            for (Map.Entry<String, List<List<String>>> entry : entries) {
                String key = entry.getKey();
                List<List<String>> value = entry.getValue();
                Cell name = createTableContentWord(key);
                name.setRowspan(value.size());
                table6.addCell(name);
                for (List<String> list : value) {
                    for (String s : list) {
                        table6.addCell(createTableContentWord(s));
                    }
                }
            }
            document.add(table6);
        }

        //三、信号检测
        com.lowagie.text.Paragraph title3 = createHeadWord(14, "三、 信号检测", Element.ALIGN_LEFT);
        title3.setSpacingAfter(10);
        title3.setSpacingBefore(10);
        document.add(title3);
        //三模块可以隐藏，动态设置标题
        int moduleTrendsTitleNum = 1;
        if (CollUtil.isNotEmpty(ptFdaList) || CollUtil.isNotEmpty(ptVigiList)) {
            //3.1 不良反应分析结果
            com.lowagie.text.Paragraph title31 = createHeadWord(14, "3 ." + moduleTrendsTitleNum + "  不良反应分析结果", Element.ALIGN_LEFT);
            title31.setSpacingAfter(10);
            title31.setSpacingBefore(10);
            document.add(title31);
            moduleTrendsTitleNum++;
            List<String> nameList78 = Arrays.asList("首选术语（PT）", "不良事件", "报告例数/例", "比例/%");
            if (CollUtil.isNotEmpty(ptFdaList)) {
                //3.1 fda说明
                String replaceAll31 = builder31Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；").replaceAll("、、", "、");
                com.lowagie.text.Paragraph data31 = createDataWord(replaceAll31);
                data31.setFirstLineIndent(25);
                document.add(data31);
            }
            if (CollUtil.isNotEmpty(ptVigiList)) {
                //3.1 vigi说明
                String replaceAll31 = builder31Vigi.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；").replaceAll("、、", "、");
                ;
                com.lowagie.text.Paragraph data31 = createDataWord(replaceAll31);
                data31.setFirstLineIndent(25);
                document.add(data31);
            }
            if (CollUtil.isNotEmpty(ptFdaList)) {
                //***************创建表格7**************表7 FAERS数据库中atorvastatin 发生频次排序（TOP 20）*********
                com.lowagie.text.Paragraph paragraphTable7Head = createHeadWord(14, "表7  FAERS数据库中" + originalI + " 发生频次排序（TOP 50）", Element.ALIGN_CENTER);
                //设置段落前后间距
                paragraphTable7Head.setSpacingAfter(10);
                paragraphTable7Head.setSpacingBefore(10);
                document.add(paragraphTable7Head);
                //表7
                Table table7 = new Table(4);
                for (String s : nameList78) {
                    Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
                    cell.setBackgroundColor(new Color(221, 221, 221));
                    cell.setUseAscender(true);
                    cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                    cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    table7.addCell(cell);
                }
                //设置表7内容
                for (List<String> list : ptFdaList) {
                    for (String s : list) {
                        table7.addCell(createTableContentWord(s));
                    }
                }
                document.add(table7);
            }
            if (CollUtil.isNotEmpty(ptVigiList)) {
                //***************创建表格8**************表8 VigiAccess数据库中atorvastatin发生频次排序（TOP 20） *********
                com.lowagie.text.Paragraph paragraphTable8Head = createHeadWord(14, "表8  VigiAccess数据库中" + originalI + "发生频次排序（TOP 50） ", Element.ALIGN_CENTER);
                //设置段落前后间距
                paragraphTable8Head.setSpacingAfter(10);
                paragraphTable8Head.setSpacingBefore(10);
                document.add(paragraphTable8Head);
                //表7
                Table table8 = new Table(4);
                for (String s : nameList78) {
                    Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
                    cell.setBackgroundColor(new Color(221, 221, 221));
                    cell.setUseAscender(true);
                    cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                    cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                    table8.addCell(cell);
                }
                //设置表8内容
                for (List<String> list : ptVigiList) {
                    for (String s : list) {
                        table8.addCell(createTableContentWord(s));
                    }
                }
                document.add(table8);
            }
        }

        //3.2 各系统器官分类的ADR信号数及ADEs报告数
        com.lowagie.text.Paragraph title32 = createHeadWord(14, "3 ." + moduleTrendsTitleNum + "  各系统器官分类的ADR信号数及ADEs报告数", Element.ALIGN_LEFT);
        title32.setSpacingAfter(10);
        title32.setSpacingBefore(10);
        document.add(title32);
        moduleTrendsTitleNum++;
        List<String> nameList910 = Arrays.asList("SOC分类/首选术语（PT）", "不良事件", "报告数/例", "ROR值", "EBGM值", "IC值");
        if (CollUtil.isNotEmpty(signalDictFdaMap) && CollUtil.isNotEmpty(signalDictVigiMap)) {
            //3.2 fda说明
            String replaceFda32 = builder32Fda.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph dataFda32 = createDataWord(replaceFda32);
            dataFda32.setFirstLineIndent(25);
            document.add(dataFda32);
        }
        if (CollUtil.isNotEmpty(signalDictVigiMap)) {
            //3.2 vig说明
            String replaceVigi32 = builder32Vigi.toString().replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph dataVigi32 = createDataWord(replaceVigi32);
            dataVigi32.setFirstLineIndent(25);
            document.add(dataVigi32);
        }
        if (CollUtil.isNotEmpty(signalDictFdaMap)) {
            //***************创建表格9**************FAERS数据库 ADEs 信号检测表（TOP 50）*********
            com.lowagie.text.Paragraph paragraphTable9Head = createHeadWord(14, "表9  FAERS数据库 ADEs 信号检测表（TOP 50）", Element.ALIGN_CENTER);
            //设置段落前后间距
            paragraphTable9Head.setSpacingAfter(10);
            paragraphTable9Head.setSpacingBefore(10);
            document.add(paragraphTable9Head);
            //表9
            Table table9 = new Table(6);
            for (String s : nameList910) {
                Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
                cell.setBackgroundColor(new Color(221, 221, 221));
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table9.addCell(cell);
            }
            //设置表9内容
            Set<String> keySet = signalDictFdaMap.keySet();
            for (String key : keySet) {
                List<List<String>> lists = signalDictFdaMap.get(key);
                Cell cell = new Cell(new com.lowagie.text.Phrase(signalDictFdaOnlyMap.get(key), fontTitle));
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_LEFT);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table9.addCell(cell);
                Cell cellSpace = new Cell(new com.lowagie.text.Phrase("", font));
                for (int i1 = 0; i1 < 5; i1++) {
                    table9.addCell(cellSpace);
                }
                for (List<String> list : lists) {
                    for (String s : list) {
                        table9.addCell(createTableContentWord(s));
                    }
                }
            }
            document.add(table9);
        }
        if (CollUtil.isNotEmpty(signalDictVigiMap)) {
            //***************创建表格10**************表10  VigiAccess数据库 ADEs 信号检测表（TOP 10））*********
            com.lowagie.text.Paragraph paragraphTable10Head = createHeadWord(14, "表10  VigiAccess数据库 ADEs 信号检测表（TOP 50）", Element.ALIGN_CENTER);
            //设置段落前后间距
            paragraphTable10Head.setSpacingAfter(10);
            paragraphTable10Head.setSpacingBefore(10);
            document.add(paragraphTable10Head);
            //表9
            Table table10 = new Table(6);
            for (String s : nameList910) {
                Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
                cell.setBackgroundColor(new Color(221, 221, 221));
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_CENTER);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table10.addCell(cell);
            }
            //设置表10内容
            Set<String> keySet = signalDictVigiMap.keySet();
            for (String key : keySet) {
                List<List<String>> lists = signalDictVigiMap.get(key);
                Cell cell = new Cell(new com.lowagie.text.Phrase(signalDictVigiOnlyMap.get(key), fontTitle));
                cell.setUseAscender(true);
                cell.setHorizontalAlignment(Element.ALIGN_LEFT);
                cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
                table10.addCell(cell);
                Cell cellSpace = new Cell(new com.lowagie.text.Phrase("", font));
                for (int i1 = 0; i1 < 5; i1++) {
                    table10.addCell(cellSpace);
                }
                for (List<String> list : lists) {
                    for (String s : list) {
                        table10.addCell(createTableContentWord(s));
                    }
                }
            }
            document.add(table10);
        }
        if (StringUtils.isNotEmpty(signalDictExplain)) {
            com.lowagie.text.Paragraph dataFda32 = createDataWord(signalDictExplain);
            dataFda32.setFirstLineIndent(25);
            document.add(dataFda32);
        }

        //   || StringUtils.isNotEmpty(builderPicture.toString())
        if (CollUtil.isNotEmpty(pictureArr)) {
            //3.3 药物-ADEs 组合的时间扫描图谱
            com.lowagie.text.Paragraph title33 = createHeadWord(14, "3 ." + moduleTrendsTitleNum + "  药物-ADEs 组合的时间扫描图谱", Element.ALIGN_LEFT);
            title33.setSpacingAfter(10);
            title33.setSpacingBefore(10);
            document.add(title33);
            //说明
            String replaceAll32 = builderPicture.toString().replaceAll("、。", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph data32 = createDataWord(replaceAll32);
            data32.setFirstLineIndent(25);
            document.add(data32);
            if (CollUtil.isNotEmpty(pictureArr)) {
                log.info("开始生成时间扫描图");
                long millis = System.currentTimeMillis();
                for (int i1 = 0; i1 < pictureArr.size(); i1++) {
                    JSONObject arrJSONObject = pictureArr.getJSONObject(i1);
                    JSONArray x = arrJSONObject.getJSONArray("x");
                    JSONArray y = arrJSONObject.getJSONArray("y");
                    JSONArray error = arrJSONObject.getJSONArray("error");
                    //开始拼接时间扫描图请求数据
                    QuickChart chart = new QuickChart();
                    chart.setWidth(500);
                    chart.setHeight(300);
                    chart.setVersion("2.9.4");
                    JSONObject configJson = new JSONObject();
                    configJson.put("type", "line");
                    configJson.put("data", new JSONObject());
                    configJson.getJSONObject("data").put("labels", new JSONArray());
                    JSONArray labels = configJson.getJSONObject("data").getJSONArray("labels");
                    for (int i2 = 0; i2 < x.size(); i2++) {
                        String xString = x.getString(i2);
                        labels.add(xString);
                    }
                    configJson.getJSONObject("data").put("datasets", new JSONArray());
                    configJson.getJSONObject("data").getJSONArray("datasets").add(new JSONObject());
                    JSONObject datasets0 = configJson.getJSONObject("data").getJSONArray("datasets").getJSONObject(0);
                    datasets0.put("label", "时间扫描图");
                    datasets0.put("data", new JSONArray());
                    JSONArray datasetsData = datasets0.getJSONArray("data");
                    for (int i2 = 0; i2 < y.size(); i2++) {
                        datasetsData.add(Double.parseDouble(y.getString(i2)));
                    }
                    datasets0.put("fill", false);
                    datasets0.put("errorBars", new JSONObject());
                    JSONObject errorBars = datasets0.getJSONObject("errorBars");
                    DecimalFormat decimalFormat = new DecimalFormat("#.00");
                    for (int i2 = 0; i2 < x.size(); i2++) {
                        String xString = x.getString(i2);
                        JSONArray errorJSONArray = error.getJSONArray(i2);
                        JSONObject inner = new JSONObject();
                        double aDouble = Double.parseDouble(y.getString(i2));
                        inner.put("plus", Double.valueOf(decimalFormat.format((errorJSONArray.getDoubleValue(2) - aDouble)>0?errorJSONArray.getDoubleValue(2) - aDouble:0)));
                        inner.put("minus", Double.valueOf(decimalFormat.format((aDouble - errorJSONArray.getDoubleValue(1))>0?aDouble - errorJSONArray.getDoubleValue(1):0)));
                        errorBars.put(xString, inner);
                    }
                    configJson.put("options", new JSONObject());
                    configJson.getJSONObject("options").put("plugins", new JSONObject());
                    configJson.getJSONObject("options").getJSONObject("plugins").put("chartJsPluginErrorBars", new JSONObject());
                    configJson.getJSONObject("options").getJSONObject("plugins").getJSONObject("chartJsPluginErrorBars").put("color", "#aaa");
                    chart.setConfig(configJson.toJSONString());
                    //log.info("时间扫描图请求参数为[{}]", path);
                    try {
                        //定义请求时间，请求时间过长后重新请求
                        /*FutureTask<byte[]> getBytes = new FutureTask<>(chart::toByteArray);
                        byte[] bytes = new byte[0];
                        try {
                            bytes = getBytes.get(10000, TimeUnit.MILLISECONDS);
                        } catch (InterruptedException | ExecutionException | TimeoutException e) {
                            log.error("时间扫描图异常[{}]", e.getCause() != null ? e.getCause().getMessage() : e.toString());
                            //超时时取消当前线程
                            boolean cancel = getBytes.cancel(true);
                            log.error("时间扫描图线程等待时间超长关闭当前线程[{}]，重新请求", cancel);
                            //重新请求线程
                            getBytes = new FutureTask<>(chart::toByteArray);
                            try {
                                bytes = getBytes.get(10000, TimeUnit.MILLISECONDS);
                            } catch (InterruptedException | ExecutionException | TimeoutException ex) {
                                log.error("时间扫描图异常[{}]", ex.getCause() != null ? ex.getCause().getMessage() : ex.toString());
                                log.error("时间扫描图再次超时，降级去除该时间扫描图");
                            }
                        }*/

                        ExecutorService exec = Executors.newSingleThreadExecutor();
                        Callable<byte[]> call = chart::toByteArray;
                        Future<byte[]> future = exec.submit(call);
                        byte[] bytes = new byte[0];
                        try {
                            bytes = future.get(1000 * 6, TimeUnit.MILLISECONDS);
                        } catch (InterruptedException | ExecutionException | TimeoutException e) {
                            log.error("时间扫描图异常[{}]", e.getCause() != null ? e.getCause().getMessage() : e.toString());
                            //超时时取消当前线程
                            boolean cancel = future.cancel(true);
                            log.error("时间扫描图线程等待时间超长关闭当前线程[{}]，重新请求", cancel);
                            //重新请求线程
                            call = chart::toByteArray;
                            future = exec.submit(call);
                            try {
                                bytes = future.get(1000 * 6, TimeUnit.MILLISECONDS);
                            } catch (InterruptedException | ExecutionException | TimeoutException ex) {
                                log.error("时间扫描图异常[{}]", ex.getCause() != null ? ex.getCause().getMessage() : ex.toString());
                                log.error("时间扫描图再次超时，降级去除该时间扫描图");
                            }
                        }
                        exec.shutdown();

                        //byte[] bytes = chart.toByteArray();
                        if (bytes.length > 0) {
                            com.lowagie.text.Image image = com.lowagie.text.Image.getInstance(bytes);
                            image.setAlignment(Image.ALIGN_CENTER);
                            image.scaleAbsolute(500, 300);
                            document.add(image);

                            String title = arrJSONObject.getString("title");
                            com.lowagie.text.Paragraph paragraphTable = createHeadWord(14, title, Element.ALIGN_CENTER);
                            paragraphTable.setSpacingAfter(10);
                            paragraphTable.setSpacingBefore(10);
                            document.add(paragraphTable);
                        }
                    } catch (RuntimeException e) {
                        e.printStackTrace();
                    }
                }
                log.info("时间扫描图生成完成，用时[{}]", System.currentTimeMillis() - millis);
            }
        }

        //四、结论
        com.lowagie.text.Paragraph title4 = createHeadWord(14, "四、结论", Element.ALIGN_LEFT);
        title4.setSpacingAfter(10);
        title4.setSpacingBefore(10);
        document.add(title4);
        //结论部分
        List<String> explainFda = new ArrayList<>();
        List<String> explainVigi = new ArrayList<>();
        if (!analysisOverview.isEmpty()) {
            JSONArray analysisList = analysisOverview.getJSONArray("list");
            if (CollUtil.isNotEmpty(analysisList)) {
                explainFda.add(analysisList.getString(1));
            }
        }
        //2.1
        String str21 = fda21.toString();
        if (StringUtils.isNotEmpty(str21)) {
            explainFda.add(str21);
        }
        //2.2
        String str22 = fda22.toString();
        if (StringUtils.isNotEmpty(str22)) {
            explainFda.add(str22);
        }
        //2.3
        String str23 = fda23.toString();
        if (StringUtils.isNotEmpty(str23)) {
            str23 = str23.replaceAll("，。", "。");
            explainFda.add(str23);
        }
        //2.4
        String str24 = fda24.toString();
        if (StringUtils.isNotEmpty(str24)) {
            explainFda.add(str24);
        }
        //2.5
        String str25 = fda25.toString();
        if (StringUtils.isNotEmpty(str25)) {
            explainFda.add(str25);
        }
        if (CollUtil.isNotEmpty(ptFdaList)) {
            //3.1
            String str31 = fda31.toString().replaceAll("、、", "、");
            if (StringUtils.isNotEmpty(str31)) {
                explainFda.add(str31);
            }
        }
        if (CollUtil.isNotEmpty(signalDictFdaMap)) {
            //3.2
            String str32 = fda32.toString();
            if (StringUtils.isNotEmpty(str32)) {
                explainFda.add(str32);
            }
        }

        //vigi 2.1
        String strVigi21 = vigi21.toString();
        if (StringUtils.isNotEmpty(strVigi21)) {
            explainVigi.add(strVigi21);
        }
        //vigi 3.1
        String strVigi31 = vigi31.toString().replaceAll("、、", "、");
        if (StringUtils.isNotEmpty(strVigi31)) {
            explainVigi.add(strVigi31);
        }
        //vigi 3.2
        String strVigi32 = vigi32.toString();
        if (StringUtils.isNotEmpty(strVigi32)) {
            explainVigi.add(strVigi32);
        }
        for (String s : explainFda) {
            String replace = s.replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
            com.lowagie.text.Paragraph data = createExplainWord(replace);
            data.setFirstLineIndent(25);
            document.add(data);
        }
        if (type == 2) {
            document.add(createDataWord("    "));
            for (String s : explainVigi) {
                String replace = s.replaceAll("。；", "。").replaceAll("；；", "；").replaceAll("：；", "；");
                com.lowagie.text.Paragraph data = createExplainWord(replace);
                data.setFirstLineIndent(25);
                document.add(data);
            }
        }

        //附录
        com.lowagie.text.Paragraph titleAppendix = createHeadWord(14, "附录", Element.ALIGN_LEFT);
        titleAppendix.setSpacingAfter(10);
        titleAppendix.setSpacingBefore(10);
        document.add(titleAppendix);
        //资料与方法
        com.lowagie.text.Paragraph titleAppendix1 = createHeadWord(14, "资料与方法", Element.ALIGN_LEFT);
        titleAppendix1.setSpacingAfter(10);
        titleAppendix1.setSpacingBefore(10);
        document.add(titleAppendix1);
        //数据来源
        com.lowagie.text.Paragraph titleAppendix2 = createHeadWord(14, "数据来源", Element.ALIGN_LEFT);
        titleAppendix2.setSpacingAfter(10);
        titleAppendix2.setSpacingBefore(10);
        document.add(titleAppendix2);
        //data
        com.lowagie.text.Paragraph data1 = createDataWord("本次研究数据来源于FAERS和WHO-Vigibase数据库中的公开数据-VigiAccess数据库。FAERS 包括了 FDA 收集的所有不良事件信息和用药错误信息( 包括欧洲报告可能与严重事件和其他非欧洲的数据有关)。其所有 ADEs 数据采用国际医学用语词典( Medical Dictionary for Drug Ｒegulatory Activities，MedDＲA)的首选术语( preferred terms，PTs) 进行编码。FAERS 数据库自 2004 年开始对外公开，每季度进行数据更新，数据信息量极大，可有效用于药品上市后安全性风险监测及评价，其可获得药物各个ADR的例数以及ADR的详情，包括年龄、性别、合并用药、转归等。VigiAccess是收集来自于卫生保健专业人员、制药公司的全球安全报告，公开的数据可以获得药物总的ADR的地区、年龄、性别、报告年份的分布，以及药物各个ADR的总例数。");
        document.add(data1);
        //数据处理
        com.lowagie.text.Paragraph titleAppendix3 = createHeadWord(14, "数据处理", Element.ALIGN_LEFT);
        titleAppendix3.setSpacingAfter(10);
        titleAppendix3.setSpacingBefore(10);
        document.add(titleAppendix3);
        //data
        com.lowagie.text.Paragraph data2 = createDataWord("由于FAERS数据库和VigiAccess数据库的数据结构差异，两个库的数据处理方式不同：FAERS数据库：本研究从该库中提取2004年第1季度至2023年第1季度，共77个季度中所有包含" + originalI + "的ADE，剔除重复和错误数据后，筛选出以" + originalI + "为怀疑药物（首要怀疑和次要怀疑） " + (StringUtils.isNotEmpty(originalO) ? "并导致" + originalO : "") + " 的ADE报告进行分析。" + (type == 1 ? "" : "VigiAccess数据库：由于数据结构限制，本研究仅从该库中提取所有包含" + originalI + "的ADE报告进行分析，数据库限定时间为“建库时间”到2022-09-14。"));
        data2.setFirstLineIndent(25);
        document.add(data2);
        //信号检测方法
        com.lowagie.text.Paragraph titleAppendix4 = createHeadWord(14, "信号检测方法", Element.ALIGN_LEFT);
        titleAppendix4.setSpacingAfter(10);
        titleAppendix4.setSpacingBefore(10);
        document.add(titleAppendix4);
        //data
        com.lowagie.text.Paragraph data3 = createDataWord("本研究采用药物不良反应信号信息标准值( information component，IC) 、经验贝叶斯几何均值( empirical bayes geometric mean， EBGM ) 、报告比值比 ( reporting odds ratio，ROR) 进行信号检测。算法的具体计算公式及信号检测标准表 1，其中 a，b，c，d 的意义见表 2。");
        data3.setFirstLineIndent(25);
        document.add(data3);
        //（1）信息标准值
        com.lowagie.text.Paragraph titleAppendix5 = createHeadWord(14, "（1）信息标准值", Element.ALIGN_LEFT);
        titleAppendix5.setSpacingAfter(10);
        titleAppendix5.setSpacingBefore(10);
        document.add(titleAppendix5);
        //data
        com.lowagie.text.Paragraph data4 = createDataWord("IC 值是通过贝叶斯置信度递进神经网络 ( bayesian confidence propagation neural network， BCPNN) 获得的药物与不良反应之间的关联指标。由于药物不良反应监测数据库可以表达为由 a 种药物和 b 种不良反应构成的 a × b 矩阵。 基于目标不相称性测定分析理论，目标药物的不良反应事件在所有事件中出现的频率相对于背景事件明显不相称并达到一定的标准，则认为药物 A 和不良反应 B 是一个可疑的不良反应信号。因此，我们将 IC 值作为首个药物不良反应的识别指标。");
        data4.setFirstLineIndent(25);
        document.add(data4);
        //（2）经验贝叶斯几何均值
        com.lowagie.text.Paragraph titleAppendix6 = createHeadWord(14, "（2）经验贝叶斯几何均值", Element.ALIGN_LEFT);
        titleAppendix6.setSpacingAfter(10);
        titleAppendix6.setSpacingBefore(10);
        document.add(titleAppendix6);
        //data
        com.lowagie.text.Paragraph data5 = createDataWord("EBGM 是由伽玛泊松分布缩减法 ( gamma Poisson shrinker，GPS) 获得的药物与不良反应之间的关联指标，也是美国 FDA 使用的药物不良反应监测指标，基本假设是目标药物的不良反应报告数服从泊松分布。");
        data5.setFirstLineIndent(25);
        document.add(data5);
        //（3）报告比值比
        com.lowagie.text.Paragraph titleAppendix7 = createHeadWord(14, "（3）报告比值比", Element.ALIGN_LEFT);
        titleAppendix7.setSpacingAfter(10);
        titleAppendix7.setSpacingBefore(10);
        document.add(titleAppendix7);
        //data
        com.lowagie.text.Paragraph data61 = createDataWord("ROR 是通过频数法获得的药物与不良反应之间关系的关联指标，是暴露于某一药物的特定不良反应与其他不良反应的比值除以未暴露于该药物的特定不良反应与其他所有事件之比。");
        data61.setFirstLineIndent(25);
        document.add(data61);
        com.lowagie.text.Paragraph data62 = createDataWord("另外，本研究基于 BCPNN 检测方法绘制重点关注的药物-不良事件组合 IC 值及其 95%置信区间的时间扫描图谱。该图谱体现了数据库中目标不良事件随时间推移报告数增加时信号的变化趋势；若图谱呈平稳或上升趋势且置信区间逐渐变窄，则提示信号稳定且关联性强；若呈波动趋势则提示信号不稳定，关联性不强。");
        data62.setFirstLineIndent(25);
        document.add(data62);
        //插入图片
        com.lowagie.text.Paragraph titleImage = createHeadWord(14, "计算公式和信号检测标准", Element.ALIGN_LEFT);
        titleImage.setAlignment(Element.ALIGN_CENTER);
        titleImage.setSpacingAfter(10);
        titleImage.setSpacingBefore(10);
        document.add(titleImage);
        ClassPathResource classPathResource = new ClassPathResource("/static/data.png");
        InputStream inputStreamImg = classPathResource.getInputStream();
        byte[] bytes = IOUtils.toByteArray(inputStreamImg);
        com.lowagie.text.Image image = com.lowagie.text.Image.getInstance(bytes);
        image.setAlignment(Image.ALIGN_CENTER);
        image.scaleAbsolute(500, 425);
        document.add(image);
        //创建 比值失衡测量法四格表
        com.lowagie.text.Paragraph titleTable = createHeadWord(14, "比值失衡测量法四格表", Element.ALIGN_LEFT);
        titleTable.setAlignment(Element.ALIGN_CENTER);
        titleTable.setSpacingAfter(10);
        titleTable.setSpacingBefore(10);
        document.add(titleTable);
        //data
        List<String> nameList = Arrays.asList("项目", "目标ADEs报告数", "其他ADEs报告数", "合计");
        Table table = new Table(4);
        //table.setWidth(com.lowagie.text.PageSize.A4.getWidth() - 100);
        for (String s : nameList) {
            Cell cell = new Cell(new com.lowagie.text.Phrase(s, font));
            cell.setBackgroundColor(new Color(221, 221, 221));
            cell.setUseAscender(true);
            cell.setHorizontalAlignment(Element.ALIGN_CENTER);
            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
            table.addCell(cell);
        }
        //设置内容
        List<List<String>> dataList = new ArrayList<>();
        List<String> lastData1 = Arrays.asList("目标药物", "a", "b", "a+b");
        List<String> lastData2 = Arrays.asList("其他药物", "c", "d", "c+d");
        List<String> lastData3 = Arrays.asList("合计", "a+c", "b+d", "a+b+c+d");
        dataList.add(lastData1);
        dataList.add(lastData2);
        dataList.add(lastData3);
        for (List<String> list : dataList) {
            for (String s : list) {
                table.addCell(createTableContentWord(s));
            }
        }
        document.add(table);

        // 关闭文档，才能输出
        document.close();
        writer.close();
        log.info("----------报告[{}]下载完成----------", fileName);
    }

    @Override
    public JSONArray showHistory(Long userId,String type) {
        JSONArray result = new JSONArray();
        List<String> ids = new ArrayList<>();
        Query query = new Query(Criteria.where("userId").is(userId));
        if ("1".equals(type)){
            query.addCriteria(Criteria.where("conditionPlus").exists(true).andOperator(Criteria.where("conditionPlus").ne("")));
            query.addCriteria(Criteria.where("isApp").ne("1"));
        }else {
            query.addCriteria(Criteria.where("isApp").is("1"));
        }
        query.with(PageRequest.of(0, 10, Sort.by(Sort.Direction.DESC, "timeStamp")));
        List<Condition> conditions = mongoTemplate.find(query, Condition.class);
        for (Condition condition : conditions) {
            String id = condition.getId();
            String word = condition.getConditionPlus();
            //app则为直接获取原来的输入词
            if (!"1".equals(type)){
                word = condition.getCondition();
            }
            ids.add(id);
            JSONObject inner = new JSONObject();
            inner.put("id", id);
            inner.put("word", word);
            inner.put("route",condition.getRoute());
            SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
            String format = dateFormat.format(condition.getTimeStamp());
            inner.put("time",format);
            result.add(inner);
        }
//        if (ids.size() == 10){
//            //删除多余的历史记录
//            try {
//                if(!"1".equals(type)){
//                Query query1 = new Query();
//                Criteria criteria1 = Criteria.where("_id").nin(ids).and("userId").is(userId).and("isApp").ne("1");
//                query1.addCriteria(criteria1);
//                mongoTemplate.remove(query1, Condition.class);}
//                else {
//                    Query query1 = new Query();
//                    Criteria criteria1 = Criteria.where("_id").nin(ids).and("userId").is(userId);
//                    query1.addCriteria(criteria1);
//                    mongoTemplate.remove(query1, Condition.class);
//                }
//            } catch (Exception e) {
//                log.error("用户[{}]历史记录超出10条部分删除异常[{}]", userId, e.getCause().getMessage());
//            }
//        }
        return result;
    }

    @Override
    public Boolean deleteHistory(String ids) {
        try {
            String[] id = ids.split(",");
            List<String> list = Arrays.asList(id);
            mongoTemplate.remove(new Query(Criteria.where("_id").in(list)), Condition.class);
            return true;
        } catch (Exception e) {
            log.error("单条历史记录删除失败[{}]", e.getCause().getMessage());
        }
        return false;
    }

    @Override
    public Boolean emptyHistory(Long userId) {
        try {
            mongoTemplate.remove(new Query(Criteria.where("userId").is(userId)), Condition.class);
            return true;
        } catch (Exception e) {
            log.error("清空用户[{}]历史记录失败[{}]", userId, e.getCause().getMessage());
        }
        return false;
    }

    @Override
    public List<String> getAssociationalWord(String word) {
        if (StringUtils.isBlank(word)){
            return new ArrayList<>();
        }
        if (word.length() > 20){
            return new ArrayList<>();
        }
        word = word.toLowerCase();
        PrefixQueryBuilder prefixQueryBuilder = QueryBuilders.prefixQuery("word", word);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(prefixQueryBuilder);
        nativeSearchQuery.setPageable(PageRequest.of(0,5));
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.ASC, "size"));
        //尝试去重操作-需定义keyword类型的字段进行去重操作
        //CardinalityAggregationBuilder wordBuilder = AggregationBuilders.cardinality("search").field("word").precisionThreshold(100);
        CollapseBuilder collapseBuilder = new CollapseBuilder("word");
        InnerHitBuilder innerHitBuilder = new InnerHitBuilder();
        innerHitBuilder.setSize(5);
        innerHitBuilder.setName("top_search");
        collapseBuilder.setInnerHits(innerHitBuilder);
        nativeSearchQuery.setCollapseBuilder(collapseBuilder);
        //nativeSearchQuery.setAggregations(new ArrayList<>(Collections.singletonList(wordBuilder)));
        SearchHits<AssociationalWord> search = elasticsearchRestTemplate.search(nativeSearchQuery, AssociationalWord.class);
        //对数据进行处理返回给前台
        List<String> list = new ArrayList<>();
        for (SearchHit<AssociationalWord> associationalWordSearchHit : search) {
            AssociationalWord content = associationalWordSearchHit.getContent();
            list.add(content.getWord());
        }
        return list;
    }

    //--------------------------------------pdf样式设置----------------------------------------------
    /**
     * 设置标题
     *
     * @param title 标题内容
     * @return 标题段落
     */
    private Paragraph createHead(int fontSize, String title, int alignment) throws DocumentException, IOException {
        Font font = createFont(fontSize, Font.BOLD);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(alignment);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }

    /**
     * 设置正文
     *
     * @param title 正文
     * @return 正文的段落
     */
    public Paragraph createData(String title) throws DocumentException, IOException {
        Font font = createFont(13, Font.NORMAL);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }

    public Paragraph createExplain(String title) throws DocumentException, IOException {
        Font font = createFont(13, Font.NORMAL);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        return paragraph;
    }

    /**
     * 设置正文
     *
     * @param title 正文
     * @return 正文的段落
     */
    public Paragraph createDataType(Integer size, String title, int fontMode) throws DocumentException, IOException {
        Font font = createFont(size, fontMode);
        Paragraph paragraph = new Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }

    /**
     * 根据传入的参数生成PDF文档使用的字体
     *
     * @param fontSize 字体大小
     * @param fontMode 字体正常、加粗、下划线等
     * @return 返回生成的字体
     */
    private Font createFont(int fontSize, int fontMode) throws DocumentException, IOException {
        BaseFont bfChinese = BaseFont.createFont("STSongStd-Light", "UniGB-UCS2-H", BaseFont.NOT_EMBEDDED);
        return new Font(bfChinese, fontSize, fontMode, BaseColor.BLACK);
    }

    private void paragraphPosition(PdfWriter writer, Paragraph paragraph, Integer p1, Integer p2, Integer p3, Integer p4) {
        Rectangle rectangle = new Rectangle(p1, p2, p3, p4);
        //显示边框，默认不显示，常量值：LEFT, RIGHT, TOP, BOTTOM，BOX
        rectangle.setBorder(Rectangle.BOX);
        //边框线条粗细
        rectangle.setBorderWidth(1f);
        //边框颜色
        rectangle.setBorderColor(BaseColor.WHITE);
        //背景颜色
        rectangle.setBackgroundColor(BaseColor.WHITE);
        writer.getDirectContent().rectangle(rectangle);
        ColumnText ct = new ColumnText(writer.getDirectContent());
        ct.addElement(paragraph);
        ct.setSimpleColumn(rectangle);
        try {
            ct.go();
        } catch (DocumentException e) {
            e.printStackTrace();
        }
    }

    /**
     * 根据传入的标题名称：批量设置标题值
     *
     * @param table        创建的表格对象
     * @param tableHeadStr 每个标题值按顺序来
     */
    private void createTableHead(PdfPTable table, String[] tableHeadStr) throws DocumentException, IOException {
        if (ObjectUtils.isEmpty(tableHeadStr)) {
            return;
        }
        //获取设置表格标题的字体
        Font font = createFont(14, Font.NORMAL);
        for (String tableHead : tableHeadStr) {
            PdfPCell cell = new PdfPCell(new Phrase(tableHead, font));
            if ("影响因素".equals(tableHead)) {
                cell.setRowspan(2);
            }
            if ("FAERS数据库".equals(tableHead)) {
                cell.setColspan(2);
            }
            if ("影响因素-2".equals(tableHead)) {
                cell = new PdfPCell(new Phrase(tableHead.split("-")[0], font));
            }
            cell.setBackgroundColor(new BaseColor(221, 221, 221));
            cell.setMinimumHeight(20);
            cell.setUseAscender(true);
            cell.setHorizontalAlignment(Element.ALIGN_CENTER);
            cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
            table.addCell(cell);
        }
    }

    /**
     * 设置表格内容
     *
     * @param text 表格内容
     * @return 表格内容
     */
    private PdfPCell createTableContent(String text) throws DocumentException, IOException {
        Font font = createFont(14, Font.NORMAL);
        PdfPCell cell = new PdfPCell(new Phrase(text, font));
        cell.setMinimumHeight(20);
        cell.setUseAscender(true);
        cell.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
        return cell;
    }


    //--------------------------------word样式设置----------------------------------------
    private com.lowagie.text.Paragraph createHeadWord(int fontSize, String title, int alignment) throws com.lowagie.text.DocumentException, IOException {
        com.lowagie.text.Font font = createFontWord(fontSize, Font.BOLD);
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph(title, font);
        paragraph.setAlignment(alignment);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }

    private com.lowagie.text.Font createFontWord(int fontSize, int fontMode) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.pdf.BaseFont bfChinese = com.lowagie.text.pdf.BaseFont.createFont("Helvetica", "Cp1252", BaseFont.NOT_EMBEDDED);
        return new com.lowagie.text.Font(bfChinese, fontSize, fontMode, Color.BLACK);
    }

    public com.lowagie.text.Paragraph createDataWord(String title) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.Font font = createFontWord(13, Font.NORMAL);
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;
    }

    private Cell createTableContentWord(String text) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.Font font = createFontWord(14, Font.NORMAL);
        Cell cell = new Cell(new com.lowagie.text.Phrase(text, font));
        cell.setUseAscender(true);
        cell.setHorizontalAlignment(Element.ALIGN_CENTER);
        cell.setVerticalAlignment(Element.ALIGN_MIDDLE);
        return cell;
    }

    public com.lowagie.text.Paragraph createDataTypeWord(Integer size, String title, int fontMode) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.Font font = createFontWord(size, fontMode);
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        paragraph.setSpacingBefore(10);
        paragraph.setSpacingAfter(10);
        return paragraph;

    }

    public com.lowagie.text.Paragraph createExplainWord(String title) throws IOException, com.lowagie.text.DocumentException {
        com.lowagie.text.Font font = createFontWord(13, Font.NORMAL);
        com.lowagie.text.Paragraph paragraph = new com.lowagie.text.Paragraph(title, font);
        paragraph.setAlignment(Element.ALIGN_LEFT);
        return paragraph;
    }
}
