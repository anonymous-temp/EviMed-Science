package com.sentum.drugsafe.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.collection.CollectionUtil;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.alibaba.fastjson.parser.Feature;
import com.alibaba.fastjson.parser.ParserConfig;
import com.alibaba.fastjson.serializer.NameFilter;
import com.amazonaws.util.Md5Utils;
import com.fasterxml.jackson.databind.JsonNode;
import com.lowagie.text.Document;
import com.lowagie.text.DocumentException;
import com.lowagie.text.Element;
import com.lowagie.text.Image;
import com.mongodb.BasicDBList;
import com.mongodb.BasicDBObject;
import com.sentum.drugsafe.dto.FdaQueryCondition;
import com.sentum.drugsafe.dto.SafeInfoDto;
import com.sentum.drugsafe.enums.ConfigEnum;
import com.sentum.drugsafe.enums.TableEnum;
import com.sentum.drugsafe.feign.*;
import com.sentum.drugsafe.pojo.*;
import com.sentum.drugsafe.service.AlertService;
import com.sentum.drugsafe.service.DrugAnalyzerService;
import com.sentum.drugsafe.trans.DeeplApi;
import com.sentum.drugsafe.trans.RedisUtil;
import com.sentum.drugsafe.trans.TranslateWordUtil;
import com.sentum.drugsafe.utils.*;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.ObjectUtils;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.elasticsearch.search.aggregations.Aggregation;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.bucket.terms.ParsedTerms;
import org.elasticsearch.search.aggregations.bucket.terms.Terms;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.elasticsearch.core.query.NativeSearchQueryBuilder;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.awt.*;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Type;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.DecimalFormat;
import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.List;
import java.util.concurrent.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static java.sql.DriverManager.println;

@Slf4j
@Service
public class DrugAnalyzerServiceImpl implements DrugAnalyzerService {

    private static String requiredMongoUri(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException(name + " must be provided by the runtime secret store");
        }
        return value.trim();
    }
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private FenciFeign fenciFeign;
    @Autowired
    FineScreenFeign fineScreenFeign;

    @Autowired
    ReleaseMongoUtil releaseMongoUtil;

    @Autowired
    RedisTemplate<String, Object> redisTemplate;

    @Autowired
    ClinicalTrialFeign clinicalTrialFeign;

    @Autowired
    UserUtil userService;

    @Autowired
    DataFeign dataFeign;

    NameFilter nameFilter = new NameFilter() {
        @Override
        public String process(Object object, String name, Object value) {
            return name.replaceAll(" ", "_");
        }
    };
    @Autowired
    private ConfigUtil configUtil;

    @Autowired
    private ManageFeign manageFeign;

    private List<String> getRole(List<String> role) {
        ArrayList<String> roles = new ArrayList<>();
        if (role == null || role.isEmpty()) {
            roles.add("PS");
            return roles;
        }
        if (role.size() < 4) {
            for (String s : role) {
                roles.add(DownloadServiceImpl.MY_CONSTANT_MAP.get(s));
            }
            return roles;
        }
        roles.add("全部");
        return roles;
    }

    public String translate(String word) {
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("word", word);
        String s = fineScreenFeign.deepl(jsonObject).replaceAll("\\.", "");
        return s;
    }


    public String translateList(List<String> word) {
        if (CollUtil.isEmpty(word)||word.contains("不限")){
            return "";
        }

        StringBuilder stringBuilder = new StringBuilder();
        for (String s : word) {
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("word", s);
            String x = fineScreenFeign.deepl(jsonObject).replaceAll("\\.", "");
            stringBuilder.append(x).append("&&");
            //还需要把原词添加上
            stringBuilder.append(s).append("&&");
        }
        String s = stringBuilder.toString().substring(0, stringBuilder.length() - 2);

        return s;
    }

    @Async
    public CompletableFuture<JSONObject> screenAsync(ScreenRequest screenRequest) {
        return CompletableFuture.supplyAsync(() -> fineScreenFeign.screen(screenRequest));
    }


    private String searchToMontage(ArrayList<List> drugs) {
        ArrayList<String> strings = new ArrayList<>();
        if (CollectionUtil.isEmpty(drugs)) {
            return "";
        }
        for (List drug : drugs) {
            for (Object o : drug) {
                JSONObject jsonObject = JSONObject.parseObject(o.toString());
                strings.add(jsonObject.getString("word"));
                strings.add(jsonObject.getString("trans"));
            }
        }
        StringBuilder stringBuilder = new StringBuilder();
        AnalyzeConditionUtils.montageForPaper(stringBuilder, strings, "");
        log.info("********************************" + stringBuilder + "********************************");
        return stringBuilder.toString();
    }

    @Override
    public JSONObject search(String query, String isApp) {
        String screenId = UUID.randomUUID().toString();
//        Condition o = (Condition) RedisUtil.redis.opsForValue().get("searchC:" + query);
//        JSONObject o1 = (JSONObject) RedisUtil.redis.opsForValue().get("searchD:" + query);
        Condition data = new Condition();
        JSONObject ret = new JSONObject();

        SysUser sysUser = this.userService.getCurrentUser();
//        if (ObjectUtils.isEmpty(o) || ObjectUtils.isEmpty(o1)) {
        //判断是否只有药
        int i = 0;
        StringBuilder queryPlusSb = new StringBuilder();

        String ands = "(联合|和|与|and|导致|造成|AND)"; //  表示和关系的药物
        String[] split = query.split(ands);
        ArrayList<List> drugs = new ArrayList<>();
        ArrayList<List> pts = new ArrayList<>();
        JSONObject jsonObject2 = filterDrugNames(query);
        String wordsRemove = "(the\\s)|[()]";
        query = query.replaceAll(wordsRemove, " ");
        if (ObjectUtils.isNotEmpty(jsonObject2)) {
            queryPlusSb.append("(");
            i = 1;
            ArrayList<JSONObject> drug = new ArrayList<>();
            drug.add(jsonObject2);
            drugs.add(drug);
            String screenQuery = "{\"generalOrFineScreen\":\"阿司匹林\",\"screenId\":null,\"screenMap\":null,\"excludeSynonyms\":null,\"translateStatus\":1,\"type\":1,\"retain\":false}";
            ScreenRequest screenRequest = JSONObject.parseObject(screenQuery, ScreenRequest.class);
            queryPlusSb.append(query + ")");
            //检索式检索
            String s = AnalyzeConditionUtils.parenthesisFormat(queryPlusSb.toString()).get(0);
            screenRequest.setGeneralOrFineScreen(query);
            screenRequest.setScreenId(screenId);
            long screenStart = System.currentTimeMillis();
            screenAsync(screenRequest);
            long screenEnd = System.currentTimeMillis();
            log.info("screen time:{}", screenEnd - screenStart);
            Date date = new Date();
            SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
            String format = formatter.format(date);
            ret.put("route", i);
            ret.put("drugs", drugs);
            ret.put("pts", pts);
            ret.put("_id", screenId);
            ret.put("query", queryPlusSb.toString());
            ret.put("isIntelligent", 1);
            ret.put("prop1", "");
            ret.put("prop2", "");
            ret.put("prop3", "");
            ret.put("prop4", "");
            ret.put("isVague", "1");
            ret.put("report", query);
            data.setRoute(i);
            data.setId(screenId);
            data.setCondition(query);
            data.setConditionPlus(queryPlusSb.toString());
            data.setIsApp(StringUtils.isNotEmpty(isApp) ? isApp : "");
            redisTemplate.opsForValue().set("searchData:" + query, ret);
            redisTemplate.opsForValue().set("searchCondition:" + query, data);
            data.setTimeStamp(System.currentTimeMillis());
            data.setUserId(Long.parseLong(sysUser.getUserId()));

            //记录历史记录
            mongoTemplate.remove(new Query(Criteria.where("condition").is(query).and("userId").is(Long.parseLong(sysUser.getUserId()))), Condition.class);
            mongoTemplate.save(data);
            if (!"1".equals(ret.get("route"))) {
                this.mongoTemplate.save(ret, "drug_adrs_search_data_supplement");
            }
            //记录搜索条件
            this.mongoTemplate.save(ret, "drug_adrs_search_data");
            return ret;
        }
        for (String s : split) {
            //第一次筛选
            queryPlusSb.append("(");
            String ors = "(或者|或|OR|,|;|、)";//或关系的药物
            String[] split1 = s.split(ors);
            ArrayList<JSONObject> drug = new ArrayList<>();
            ArrayList<String> remainings = new ArrayList<>();
            ArrayList<JSONObject> pt = new ArrayList<>();
            //判断此次或的关系是否是药
            Boolean isDrug = false;
            for (String s1 : split1) {
                JSONObject jsonObject = filterDrugNames(s1);
                if (ObjectUtils.isNotEmpty(jsonObject)) {
                    drug.add(jsonObject);
                    i = 1;
                    isDrug = true;
                    queryPlusSb.append(s1);
                    queryPlusSb.append("OR");
                } else {
                    JSONObject jsonObject1 = filterPts(s1);
                    if (ObjectUtils.isNotEmpty(jsonObject1)) {
                        pt.add(jsonObject1);
                        queryPlusSb.append(s1);
                        queryPlusSb.append("OR");
                    } else {
                        remainings.add(s1);
                    }
                }
            }
            //第二次筛选
            for (String remaining : remainings) {
                List<String> words = new ArrayList<>();
                if (remaining.length() == remaining.getBytes().length) {
                    String[] arr = remaining.split(";");
                    words.addAll(Arrays.asList(arr));
                } else {
//                    words.addAll(this.fenciFeign.jieba(remaining));
            words.add(remaining);
                }
                Object objectStopWord = RedisUtil.redis.opsForValue().get("jieba_word");
                List<String> stopWord = JSONArray.parseArray(objectStopWord.toString(), String.class);

                words.removeAll(stopWord);

                for (String str : words) {
                    boolean drugExists = false;
                    boolean drugAdrsExists = false;
                    str = str.trim();
                    String translate = "";
                    String commodityTranslate = getCommodityTranslate(str);
                    String drugTranslate = getDrugTranslate(str);
                    if (StringUtils.isNotEmpty(commodityTranslate)) {
                        translate = commodityTranslate;
                    } else if (StringUtils.isNotEmpty(drugTranslate)) {
                        translate = drugTranslate;
                    } else {
                        JSONObject drug1 = mongoTemplate.findOne(new Query(Criteria.where("words").is(str)), JSONObject.class, "drug_name_words");
                        if (ObjectUtils.isNotEmpty(drug1)) {
                            if (GetMaxSimilarUtil.judgeChinese(str)) {
                                translate = drug1.getString("standardName").toLowerCase();
                            } else {
                                translate = drug1.getString("zhStandardName").toLowerCase();
                            }
                            drugAdrsExists = true;

                        } else {
                            translate = translate(str).replaceAll(wordsRemove, "").toLowerCase();
                            BasicDBList orDbList = new BasicDBList();
                            orDbList.add(new BasicDBObject("words", translate));
                            Criteria orCriteria = Criteria.where("$or").is(orDbList);
                            Query queryz = new Query(orCriteria);
                            drugExists = this.mongoTemplate.exists(queryz, JSONObject.class, "drug_name_words");
                            if (!drugExists) {
                                Criteria criteria1 = new Criteria();
                                criteria1.orOperator(Criteria.where("drugName").is(str),
                                        Criteria.where("drugName").is(translate));
                                Query queryx = new Query(criteria1);
                                drugAdrsExists = this.mongoTemplate.exists(queryx, JSONObject.class, "zgm_adrs");
                            }
                        }
                    }
                    queryPlusSb.append(str);
                    queryPlusSb.append("OR");
                    JSONObject wordRes = new JSONObject();
                    wordRes.put("word", str.toLowerCase());
                    wordRes.put("trans", translate.toLowerCase());
                    wordRes.put("enSynonym", str.length() == str.getBytes().length ? getSynonym(str) : getSynonym(translate));
                    wordRes.put("zhSynonym", str.length() != str.getBytes().length ? getSynonym(str) : getSynonym(translate));
                    wordRes.put("userSynonym", new ArrayList<>());
                    if (drugAdrsExists || drugExists) {
                        i = 1;
                        drug.add(wordRes);
                        isDrug = true;
                    } else {
                        pt.add(wordRes);
                    }
                }
            }
            int length = queryPlusSb.length();
            if (length >= 2) {
                queryPlusSb.delete(length - 2, length);
                queryPlusSb.append(")AND");
            }

            if (isDrug) {
                drugs.add(drug);
            } else {
                pts.add(pt);
            }
        }
        String screenQuery = "{\"generalOrFineScreen\":\"阿司匹林\",\"screenId\":null,\"screenMap\":null,\"excludeSynonyms\":null,\"translateStatus\":1,\"type\":1,\"retain\":false}";
        ScreenRequest screenRequest = JSONObject.parseObject(screenQuery, ScreenRequest.class);
        screenRequest.setScreenId(screenId);
        queryPlusSb.delete(queryPlusSb.length() - 3, queryPlusSb.length());
        //检索式检索
        String s = AnalyzeConditionUtils.parenthesisFormat(queryPlusSb.toString()).get(0);
        screenRequest.setGeneralOrFineScreen(searchToMontage(drugs));
        screenAsync(screenRequest);
        Date date = new Date();
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
        String format = formatter.format(date);

        ret.put("route", i);
        ret.put("drugs", drugs);
        ret.put("pts", pts);
        ret.put("_id", screenId);
        ret.put("query", queryPlusSb.toString());
        ret.put("isIntelligent", 1);
        ret.put("prop1", "");
        ret.put("prop2", "");
        ret.put("prop3", "");
        ret.put("prop4", "");
        ret.put("isVague", "1");
        ret.put("report", query);

        data.setRoute(i);
        data.setId(screenId);
        data.setCondition(query);
        data.setConditionPlus(queryPlusSb.toString());
        data.setIsApp(StringUtils.isNotEmpty(isApp) ? isApp : "");
        redisTemplate.opsForValue().set("searchD:" + query, ret, 60, TimeUnit.MINUTES);
        redisTemplate.opsForValue().set("searchC:" + query, data, 60, TimeUnit.MINUTES);
//        } else {
//            data = o;
//            ret = o1;
//        }

        data.setTimeStamp(System.currentTimeMillis());
        data.setUserId(Long.parseLong(sysUser.getUserId()));

        //记录历史记录
        mongoTemplate.remove(new Query(Criteria.where("condition").is(query).and("userId").is(Long.parseLong(sysUser.getUserId()))), Condition.class);
        mongoTemplate.save(data);
        if (!"1".equals(ret.get("route"))) {
            this.mongoTemplate.save(ret, "drug_adrs_search_data_supplement");
        }
        //记录搜索条件
        this.mongoTemplate.save(ret, "drug_adrs_search_data");

        return ret;
    }

    private JSONObject filterPts(String str) {
        String wordsRemove = "(the\\s)|[()]";
        str = str.trim().replaceAll(wordsRemove, "");
        String translate = "";
        Criteria criteria = new Criteria();
        criteria.orOperator(Criteria.where("adrs_en").is(str), Criteria.where("adrs_ch").is(str));
        JSONObject one = mongoTemplate.findOne(new Query(criteria), JSONObject.class, "fears_vigi_adrs");
        if (ObjectUtils.isNotEmpty(one)) {
            if (GetMaxSimilarUtil.judgeChinese(str)) {
                translate = one.getString("adrs_en");
            } else {
                translate = one.getString("adrs_ch");
            }
            JSONObject wordRes = new JSONObject();
            wordRes.put("word", str);
            wordRes.put("trans", translate);
            wordRes.put("enSynonym", str.length() == str.getBytes().length ? getSynonym(str) : getSynonym(translate));
            wordRes.put("zhSynonym", str.length() != str.getBytes().length ? getSynonym(str) : getSynonym(translate));
            wordRes.put("userSynonym", new ArrayList<>());
            wordRes.put("type", "drug");
            return wordRes;
        }

        return null;


    }

    @Override
    public JSONObject searchPlus(SearchCondition searchCondition) {
        SysUser sysUser = this.userService.getCurrentUser();
        String drugNames = searchCondition.getDrugNames();
        String adverseNames = searchCondition.getAdverse();
        List<List> drugNamePlus = new ArrayList<>();
        List<List> adverseNamePlus = new ArrayList<>();
        String question;

        String ors = "(或者|或|or|OR|,|;)";//或关系的药物
        String wordsRemove = "(the\\s)|[()]";//去除开头的the
        String search = "";
        Boolean isIntelligent = false;
        //是否翻译

        if (StringUtils.isNotEmpty(drugNames)) {
            //获取()内内容并且根据属相去拓展中英文
            List<String> drugName = AnalyzeConditionUtils.parenthesisFormat(drugNames);
            for (int i = 0; i < drugName.size(); i++) {
                List<JSONObject> strings = new ArrayList<>();
                String[] split = drugName.get(i).split(ors);
                for (String s1 : split) {
                    String translate = "";
                    String commodityTranslate = getCommodityTranslate(s1);
                    String drugTranslate = getDrugTranslate(s1);
                    if (StringUtils.isNotEmpty(commodityTranslate)) {
                        translate = commodityTranslate;
                    } else if (StringUtils.isNotEmpty(drugTranslate)) {
                        translate = drugTranslate;
                    } else {
                        JSONObject drug1 = mongoTemplate.findOne(new Query(Criteria.where("words").is(s1)), JSONObject.class, "drug_name_words");
                        if (ObjectUtils.isNotEmpty(drug1)) {
                            if (GetMaxSimilarUtil.judgeChinese(s1)) {
                                translate = drug1.getString("standardName").toLowerCase();
                            } else {
                                translate = drug1.getString("zhStandardName").toLowerCase();
                            }
                        } else {
                            translate = translate(s1).replaceAll(wordsRemove, "").toLowerCase();
                        }
                    }
                    JSONObject wordRes = new JSONObject();
                    wordRes.put("word", s1.toLowerCase().trim());
                    wordRes.put("trans", translate);
                    wordRes.put("enSynonym", s1.length() == s1.getBytes().length ? getSynonym(s1) : getSynonym(translate));
                    wordRes.put("zhSynonym", s1.length() != s1.getBytes().length ? getSynonym(s1) : getSynonym(translate));
                    wordRes.put("userSynonym", new ArrayList<>());
                    wordRes.put("type", "drug");
                    strings.add(wordRes);
                    search += s1 + ",";
                }
                drugNamePlus.add(strings);
            }
        }

        if (StringUtils.isNotEmpty(adverseNames)) {
            //获取()内内容
            List<String> adverseName = AnalyzeConditionUtils.parenthesisFormat(adverseNames);
            for (int i = 0; i < adverseName.size(); i++) {
                //去重

                List<JSONObject> strings = new ArrayList<>();
                String[] split = adverseName.get(i).split(ors);
                for (String s1 : split) {
                    s1 = s1.trim();
                    String translate;
                    Criteria criteria = new Criteria();
                    criteria.orOperator(Criteria.where("adrs_en").is(s1), Criteria.where("adrs_ch").is(s1));
                    JSONObject one = mongoTemplate.findOne(new Query(criteria), JSONObject.class, "fears_vigi_adrs");
                    if (ObjectUtils.isNotEmpty(one)) {
                        if (GetMaxSimilarUtil.judgeChinese(s1)) {
                            translate = one.getString("adrs_en").toLowerCase();
                        } else {
                            translate = one.getString("adrs_ch").toLowerCase();
                        }
                    } else {
                        translate = translate(s1).replaceAll(wordsRemove, "").toLowerCase();
                    }
                    JSONObject wordRes = new JSONObject();
                    wordRes.put("word", s1);
                    wordRes.put("trans", translate);
                    wordRes.put("enSynonym", s1.length() == s1.getBytes().length ? getSynonym(s1) : getSynonym(translate));
                    wordRes.put("zhSynonym", s1.length() != s1.getBytes().length ? getSynonym(s1) : getSynonym(translate));
                    wordRes.put("userSynonym", new ArrayList<>());
                    wordRes.put("type", "pt");
                    strings.add(wordRes);
                }
                adverseNamePlus.add(strings);
            }
        }
        if (drugNamePlus.size() > 0 && adverseNamePlus.size() > 0) {
            question = drugNames + "AND" + adverseNames;
        } else if (drugNamePlus.size() > 0) {
            question = drugNames;
        } else {
            question = adverseNames;
        }
        String screenId = "";
        if (StringUtils.isNotEmpty(search)) {
            String screenQuery = "{\"generalOrFineScreen\":\"阿司匹林\",\"screenId\":null,\"screenMap\":null,\"excludeSynonyms\":null,\"translateStatus\":1,\"type\":1,\"retain\":false}";
            ScreenRequest screenRequest = JSONObject.parseObject(screenQuery, ScreenRequest.class);
            screenRequest.setGeneralOrFineScreen(search);
            JSONObject screen = this.fineScreenFeign.screen(screenRequest);
            screenId = screen.getJSONObject("data").getString("screenId");
        }
        if (StringUtils.isEmpty(screenId)) {
            screenId = UUID.randomUUID().toString();
        }
        JSONObject ret = new JSONObject();
        ret.put("route", StringUtils.isNotEmpty(drugNames) ? 1 : 0);
        ret.put("drugs", drugNamePlus);
        ret.put("pts", adverseNamePlus);
        ret.put("_id", screenId);
        ret.put("reportStartTime", searchCondition.getReportStartTime());
        ret.put("reportEndTime", searchCondition.getReportEndTime());
        ret.put("isIntelligent", searchCondition.getIsIntelligent());
        ret.put("query", question);
        ret.put("prop1", "");
        ret.put("prop2", "");
        ret.put("prop3", "");
        ret.put("prop4", "");
        ret.put("isVague", "0".equals(searchCondition.getIsPrecise()) ? "1" : "0");
        ret.put("report", question);
        Condition data = new Condition();
        data.setRoute(StringUtils.isNotEmpty(drugNames) ? 1 : 0);
        data.setId(screenId);
        data.setCondition(question);
        data.setConditionPlus(question);
        data.setTimeStamp(System.currentTimeMillis());
        data.setUserId(Long.parseLong(sysUser.getUserId()));
        //记录历史记录
        mongoTemplate.remove(new Query(Criteria.where("condition").is(question).and("userId").is(Long.parseLong(sysUser.getUserId()))), Condition.class);
        mongoTemplate.save(data);
        //记录搜索条件
        this.mongoTemplate.insert(ret, "drug_adrs_search_data");
        if (StringUtils.isEmpty(drugNames)) {
            this.mongoTemplate.insert(ret, "drug_adrs_search_data_supplement");
        }

        return ret;


    }

    private JSONObject filterDrugNames(String str) {
        String wordsRemove = "(the\\s)";
        str = str.trim().replaceAll(wordsRemove, "");
        String translate = "";
        String commodityTranslate = getCommodityTranslate(str);
        String drugTranslate = getDrugTranslate(str);
        if (StringUtils.isNotEmpty(commodityTranslate)) {
            translate = commodityTranslate;
        } else if (StringUtils.isNotEmpty(drugTranslate)) {
            translate = drugTranslate;
        } else {
            JSONObject drug1 = mongoTemplate.findOne(new Query(Criteria.where("words").is(str)), JSONObject.class, "drug_name_words");
            if (ObjectUtils.isNotEmpty(drug1)) {
                if (GetMaxSimilarUtil.judgeChinese(str)) {
                    translate = drug1.getString("standardName").toLowerCase();
                } else {
                    translate = drug1.getString("zhStandardName").toLowerCase();
                }
            } else {
                translate = translate(str).replaceAll(wordsRemove, "").toLowerCase();
                BasicDBList orDbList = new BasicDBList();
                orDbList.add(new BasicDBObject("words", translate));
                Criteria orCriteria = Criteria.where("$or").is(orDbList);
                Query queryz = new Query(orCriteria);
                boolean drugExists = this.mongoTemplate.exists(queryz, JSONObject.class, "drug_name_words");
                boolean drugAdrsExists = false;
                if (!drugExists) {
                    Criteria criteria1 = new Criteria();
                    criteria1.orOperator(Criteria.where("drugName").is(str),
                            Criteria.where("drugName").is(translate));
                    Query queryx = new Query(criteria1);
                    drugAdrsExists = this.mongoTemplate.exists(queryx, JSONObject.class, "zgm_adrs");
                    Criteria criteriapt = new Criteria();
                    criteriapt.orOperator(Criteria.where("adrs_en").is(str), Criteria.where("adrs_ch").is(str));
                    boolean ptAdrsExists = this.mongoTemplate.exists(new Query(criteriapt), JSONObject.class, "fears_vigi_adrs");
                    if (ptAdrsExists || !drugAdrsExists) {
                        return null;
                    }
                }
            }
        }
        JSONObject wordRes = new JSONObject();
        wordRes.put("word", str.toLowerCase());
        wordRes.put("trans", translate.toLowerCase());
        wordRes.put("enSynonym", str.length() == str.getBytes().length ? getSynonym(str) : getSynonym(translate));
        wordRes.put("zhSynonym", str.length() != str.getBytes().length ? getSynonym(str) : getSynonym(translate));
        wordRes.put("userSynonym", new ArrayList<>());
        wordRes.put("type", "drug");
        return wordRes;
    }


    private String getCommodityTranslate(String str) {
        str = str.trim();
        BoolQueryBuilder synonymBoolQueryBuilder = QueryBuilders.boolQuery();

        BoolQueryBuilder orBoolQueryBuilder = QueryBuilders.boolQuery();
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", str));  // 商品名
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", str));  // 商品名
        synonymBoolQueryBuilder.must().add(orBoolQueryBuilder);
        //可以为空，空直接调用翻译
//        BoolQueryBuilder notBlankBoolQueryBuilder = QueryBuilders.boolQuery();
//        if (GetMaxSimilarUtil.judgeChinese(str)) {
//            notBlankBoolQueryBuilder.must().add(QueryBuilders.existsQuery("commodityNameEn"));
//            notBlankBoolQueryBuilder.mustNot().add(QueryBuilders.termQuery("commodityNameEn.keyword", ""));
//        } else {
//            notBlankBoolQueryBuilder.must().add(QueryBuilders.existsQuery("commodityNameZh"));
//            notBlankBoolQueryBuilder.mustNot().add(QueryBuilders.termQuery("commodityNameZh.keyword", ""));
//        }
//        synonymBoolQueryBuilder.must().add(notBlankBoolQueryBuilder);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(synonymBoolQueryBuilder);
        SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, DrugAndIndicationIndex.class);
        if (drugAndIndicationIndexSearchHit != null) {
            DrugAndIndicationIndex drugAndIndicationIndex = drugAndIndicationIndexSearchHit.getContent();
            if (GetMaxSimilarUtil.judgeChinese(str)) {
                if (StringUtils.isNotEmpty(drugAndIndicationIndex.getCommodityNameEn())) {
                    return drugAndIndicationIndex.getCommodityNameEn();
                } else {
                    return translate(str);
                }
            } else {
                if (StringUtils.isNotEmpty(drugAndIndicationIndex.getCommodityNameZh())) {
                    return drugAndIndicationIndex.getCommodityNameZh();
                } else {
                    return translate(str);
                }
            }
        }
        return null;

    }


    private String getDrugTranslate(String str) {
        str = str.trim();
        String translate = "";

        // 利用es 查询 中英文对应的翻译词
        BoolQueryBuilder synonymBoolQueryBuilder = QueryBuilders.boolQuery();

        BoolQueryBuilder orBoolQueryBuilder = QueryBuilders.boolQuery();
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("zhDrugName.keyword", str));  // 药品名称
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugName.keyword", str)); // 同义词 五级中英文
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugZh.keyword", str));  // 药品中文
        orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugEn.keyword", str));  // 药品英文
        synonymBoolQueryBuilder.must().add(orBoolQueryBuilder);

        BoolQueryBuilder notBlankBoolQueryBuilder = QueryBuilders.boolQuery();
        if (GetMaxSimilarUtil.judgeChinese(str)) {
//            notBlankBoolQueryBuilder.must().add(QueryBuilders.existsQuery("drugEn"));
//            notBlankBoolQueryBuilder.mustNot().add(QueryBuilders.termQuery("drugEn.keyword", ""));
        } else {
            notBlankBoolQueryBuilder.must().add(QueryBuilders.existsQuery("drugZh"));
            notBlankBoolQueryBuilder.mustNot().add(QueryBuilders.termQuery("drugZh.keyword", ""));
        }
        synonymBoolQueryBuilder.must().add(notBlankBoolQueryBuilder);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(synonymBoolQueryBuilder);
        SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, DrugAndIndicationIndex.class);
        if (Objects.nonNull(drugAndIndicationIndexSearchHit)) {
            DrugAndIndicationIndex drugInfo = drugAndIndicationIndexSearchHit.getContent();
            if (GetMaxSimilarUtil.judgeChinese(str)) {
                if (StringUtils.isNotEmpty(drugInfo.getDrugEn())) {
                    translate = drugInfo.getDrugEn();
                } else {
                    translate = translate(str);
                }
            } else {

                translate = drugInfo.getDrugZh();
            }
        }
        List<JSONObject> jsonObjects = mongoTemplate.find(Query.query(Criteria.where("drug_jd").is(str)), JSONObject.class, "drug_name_tr");
        if (CollUtil.isNotEmpty(jsonObjects)){
            translate = jsonObjects.get(0).getString("drug_zh");
            if (StringUtils.isEmpty(translate)){
                translate = translate(str);
            }
        }
        return translate;

    }

    @Override
    public JSONObject getDrugByPt(String id, String drugName, Integer sort, Integer pageNum, Integer pageSize) {
        List<String> pt = new ArrayList<>();
        JSONObject drugAdrsSearchData = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
        if (drugAdrsSearchData == null) {
            throw new RuntimeException("找不到参数id对应的查询");
        }
        JSONArray queryResultArr = drugAdrsSearchData.getJSONArray("pts");
        for (JSONArray jsonArray : queryResultArr.toJavaList(JSONArray.class)) {
            for (JSONObject queryResult : jsonArray.toJavaList(JSONObject.class)) {
                pt.add(queryResult.getString("word"));
                pt.add(queryResult.getString("trans"));
            }
        }
        for (int i = 0; i < pt.size(); i++) {
            pt.set(i, pt.get(i).toLowerCase());
        }
        Criteria criteria = new Criteria().orOperator(
                Criteria.where("description").in(pt)
        );
        // 添加新的条件：count 字段的数值大于 10
        Criteria countCriteria = Criteria.where("count").gt(4);
        // 将新的条件添加到现有的 criteria 中
        Criteria finalCriteria = new Criteria().andOperator(
                Criteria.where("database").is("fda"),
                criteria,
                countCriteria,
                Criteria.where("type").is("drugname")
        );
        Query query = new Query(finalCriteria);
        if (sort != null && sort == 1) {
            query.addCriteria(Criteria.where("indicator").is("+"));
        } else if (sort != null && sort == 0) {
            query.addCriteria(Criteria.where("indicator").is("-"));
        }
        if (StrUtil.isNotBlank(drugName)) {
            query.addCriteria(Criteria.where("drugName").is(drugName.toLowerCase()));
        }
        query.with(Sort.by(Sort.Order.desc("count")));
        long total = this.mongoTemplate.count(query, JSONObject.class, "zgm_adrs");
        query.with(PageRequest.of(pageNum - 1, pageSize));
        List<JSONObject> list = this.mongoTemplate.find(query, JSONObject.class, "zgm_adrs");
        for (JSONObject jsonObject : list) {
            jsonObject.remove("_id");
            jsonObject.remove("count");
            jsonObject.remove("rate");
            jsonObject.remove("database");
            jsonObject.remove("ror");
            jsonObject.remove("ebgm");
            jsonObject.remove("ic");
        }
        JSONObject page = new JSONObject();
        page.put("list", list);
        page.put("pageSize", pageSize);
        page.put("total", total);
        return page;
    }

    @Override
    public JSONObject getDrugByPtJd(String id, String drugName, Integer sort, Integer pageNum, Integer pageSize) {
        List<String> pt = new ArrayList<>();
        JSONObject drugAdrsSearchData = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
        if (drugAdrsSearchData == null) {
            throw new RuntimeException("找不到参数id对应的查询");
        }
        JSONArray queryResultArr = drugAdrsSearchData.getJSONArray("pts");
        for (JSONArray jsonArray : queryResultArr.toJavaList(JSONArray.class)) {
            for (JSONObject queryResult : jsonArray.toJavaList(JSONObject.class)) {
                pt.add(queryResult.getString("word"));
                pt.add(queryResult.getString("trans"));
            }
        }
        //获取日语
        List<JSONObject> jsonObjects = mongoTemplate.find(new Query(Criteria.where("pt_ch").in(pt)), JSONObject.class, "race_jp_zh");
        if (CollectionUtil.isNotEmpty(jsonObjects)) {
            for (JSONObject jsonObject : jsonObjects) {
                pt.add(jsonObject.getString("pt_en"));
            }
        }
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        if (StrUtil.isNotEmpty(drugName)) {
            boolQueryBuilder.must().add(QueryBuilders.termQuery("drugName.keyword", drugName));
        }

        BoolQueryBuilder shouldBoolQueryBuilder = new BoolQueryBuilder();
        for (int i = 0; i < pt.size(); i++) {
            shouldBoolQueryBuilder.should().add(QueryBuilders.termQuery("ptList.keyword", pt.get(i)));
        }
        boolQueryBuilder.must().add(shouldBoolQueryBuilder);
//        boolQueryBuilder.must().add(QueryBuilders.termQuery("roleCod", "怀疑药物"));
        NativeSearchQuery query = new NativeSearchQuery(boolQueryBuilder);
        query.addAggregation(AggregationBuilders.terms("drugName").field("drugName.keyword").size(10000));
        SearchHits<AdverseIndexJd> search = elasticsearchRestTemplate.search(query, AdverseIndexJd.class);
        Aggregation drugName1 = search.getAggregations().get("drugName");
        List<? extends Terms.Bucket> drugName2 = ((ParsedTerms) drugName1).getBuckets();
        JSONObject result = new JSONObject();
        if (CollectionUtil.isNotEmpty(drugName2)) {
            int fromIndex = (pageNum - 1) * pageSize;
            int toIndex = Math.min(fromIndex + pageSize, drugName2.size());
            List<? extends Terms.Bucket> paginatedBuckets = drugName2.subList(fromIndex, toIndex);

            // 处理分页后的桶
            JSONArray bucketsArray = new JSONArray();
            for (Terms.Bucket bucket : paginatedBuckets) {
                JSONObject bucketJson = new JSONObject();
                if (StringUtils.isNotEmpty(drugName)) {
                    if (bucket.getKeyAsString().contains(drugName)) {
                        bucketJson.put("drugName", bucket.getKeyAsString());
                        bucketJson.put("docCount", bucket.getDocCount());
                        bucketsArray.add(bucketJson);
                    }
                } else {
                    bucketJson.put("drugName", bucket.getKeyAsString());
                    bucketJson.put("docCount", bucket.getDocCount());
                    bucketsArray.add(bucketJson);
                }
            }
            if (StringUtils.isNotEmpty(drugName)) {
                result.put("buckets", bucketsArray);
                result.put("total", bucketsArray.size());
            } else {
                result.put("buckets", bucketsArray);
                result.put("total", drugName2.size());
            }
        } else {
            result.put("buckets", new JSONArray());
            result.put("total", 0);
        }
        return result;


    }

    private JSONObject query(FdaQueryCondition fdaQueryCondition, String drugName) {

        SysUser sysUser = this.userService.getCurrentUser();
        String searchId = fdaQueryCondition.getId();
        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("id").is(fdaQueryCondition.getId())), JSONObject.class, "drug_adrs_search_data");
        if (userSynonm == null) {
            userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(fdaQueryCondition.getId())), JSONObject.class, "drug_adrs_search_data");
        }
        //此次检索存在就使用本次检索的    否则使用最初的
        assert userSynonm != null;
        if (ObjectUtils.isEmpty(fdaQueryCondition.getReportStartTime()) && ObjectUtils.isEmpty(userSynonm.get("searchData"))) {
            fdaQueryCondition.setReportStartTime(userSynonm.getString("reportStartTime"));
            fdaQueryCondition.setReportEndTime(userSynonm.getString("reportEndTime"));
        }
        SafeInfoDto drugSafeDto = new SafeInfoDto();
        if (fdaQueryCondition.getIsOldTable()&&ObjectUtils.isNotEmpty(drugSafeDto)) {
            drugSafeDto = (SafeInfoDto) userSynonm.get("searchData");

        } else {
            SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
            String start = "2004-01-01";
            Date date = new Date();
            String end = simpleDateFormat.format(date);
            if (ObjectUtils.isNotEmpty(fdaQueryCondition.getReportStartTime())) {
                try {
                    start = simpleDateFormat.format(Long.parseLong(fdaQueryCondition.getReportStartTime())).replaceAll("-", "");
                } catch (NumberFormatException e) {
                    start = start.replaceAll("-", "");
                }
                try {
                    end = simpleDateFormat.format(Long.parseLong(fdaQueryCondition.getReportEndTime())).replaceAll("-", "");
                } catch (NumberFormatException e) {
                    end = end.replaceAll("-", "");
                }
            }
            drugSafeDto.setIsShowUnknown(fdaQueryCondition.getIsShowUnknown());
            drugSafeDto.setAge(getSomParam(fdaQueryCondition.getAge(), Arrays.asList("儿童", "成人", "老年人")));
            drugSafeDto.setADRSAccurate("false");
            drugSafeDto.setBeginDate(ObjectUtils.isNotEmpty(fdaQueryCondition.getReportStartTime()) ? start : "");
            drugSafeDto.setEndDate(ObjectUtils.isNotEmpty(fdaQueryCondition.getReportEndTime()) ? end : "");
            drugSafeDto.setDrugNamesAccurate("false");
            drugSafeDto.setBasicSearch("true");
            drugSafeDto.setUserDrugNames(getDrugEnglishNamePlus(userSynonm).replaceAll(";", "&&").replaceAll(",", "||"));
            if (StringUtils.isEmpty(drugSafeDto.getUserDrugNames())) {
                drugSafeDto.setUserDrugNames(fdaQueryCondition.getDrugName().replaceAll(";", "&&").replaceAll(",", "||"));
            }
            if (StringUtils.isEmpty(drugSafeDto.getUserDrugNames())) {
                drugSafeDto.setUserDrugNames(drugName.replaceAll(";", "&&").replaceAll(",", "||"));
                //不良反应搜药，只传药
            }
            drugSafeDto.setSex(getSomParam(fdaQueryCondition.getSex(), Arrays.asList("M", "F", "UNK")));
            drugSafeDto.setUserADRS(getptEnglishNamePlus(userSynonm).replaceAll(";", "&&").replaceAll(",", "||"));
            drugSafeDto.setUserId(sysUser.getUserId());
            drugSafeDto.setRoleCode(getSomParam(fdaQueryCondition.getRole(), Arrays.asList("PS", "SS", "C", "I")));
            drugSafeDto.setOutcCode(getSomParam(fdaQueryCondition.getSeriousOutcome(), Arrays.asList("DE", "LT", "HO", "DS", "CA", "RI", "OT", "NO")));
            drugSafeDto.setOccpCode(getSomParam(fdaQueryCondition.getCareer(), Arrays.asList("MD", "PH", "OT", "LW", "CN", "NO")));
            drugSafeDto.setUserIndications(translateList(fdaQueryCondition.getIndication()));
            drugSafeDto.setSearchID(searchId);
            log.info("安全性分析查询条件:{}", drugSafeDto);
            Update update = new Update();
            update.set("searchData", drugSafeDto);
            update.set("reportStartTime", fdaQueryCondition.getReportStartTime());
            update.set("reportEndTime", fdaQueryCondition.getReportEndTime());
            update.set("fdaQuery", JSONObject.toJSON(fdaQueryCondition));
            Query query = new Query(Criteria.where("_id").is(fdaQueryCondition.getId()));
            mongoTemplate.updateFirst(query, update, "drug_adrs_search_data");
        }
        JSONObject res;
        try {
            res = JSONObject.parseObject(this.dataFeign.getData(drugSafeDto));
        } catch (Exception e) {
            log.error("安全性分析查询异常：{}", e.getMessage());
            res = new JSONObject();
            //坑
            res.put("data", new JSONObject());
        }

        log.info("安全性分析查询结果：{}", res);
        JSONObject data = res.getJSONObject("data");
        if (CollectionUtil.isNotEmpty(data)) {
            data.put("drugName", Collections.singletonList(fdaQueryCondition.getDrugName()));
        }
        data.put("id", searchId);

        return data;
    }


    private String getJdParam(List<String> list) {
        if (ObjectUtils.isEmpty(list) || list.contains("不限")) {
            return "-1";
        } else {
            String param = "";
            for (String s : list) {
                param = param + s + ",";
            }
            return param.substring(0, param.length() - 1);
        }
    }


    private JSONObject queryJd(FdaQueryCondition fdaQueryCondition, String drugName) {
        SysUser sysUser = this.userService.getCurrentUser();
        String searchId = fdaQueryCondition.getId();
        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("id").is(fdaQueryCondition.getId())), JSONObject.class, "drug_adrs_search_data");
        if (userSynonm == null) {
            userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(fdaQueryCondition.getId())), JSONObject.class, "drug_adrs_search_data");
        }
        //此次检索存在就使用本次检索的    否则使用最初的
        assert userSynonm != null;
        if (ObjectUtils.isEmpty(fdaQueryCondition.getReportStartTime()) && ObjectUtils.isEmpty(userSynonm.get("searchData"))) {
            fdaQueryCondition.setReportStartTime(userSynonm.getString("reportStartTime"));
            fdaQueryCondition.setReportEndTime(userSynonm.getString("reportEndTime"));
        }
        SafeInfoDto drugSafeDto = new SafeInfoDto();
        if (fdaQueryCondition.getIsOldTable()&& userSynonm.get("searchDataJd") != null) {
            drugSafeDto = (SafeInfoDto) userSynonm.get("searchDataJd");

        } else {
            SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
            String start = "2004-01-01";
            Date date = new Date();
            String end = simpleDateFormat.format(date);
            if (ObjectUtils.isNotEmpty(fdaQueryCondition.getReportStartTime())) {
                try {
                    start = simpleDateFormat.format(Long.parseLong(fdaQueryCondition.getReportStartTime())).replaceAll("-", "");
                } catch (NumberFormatException e) {
                    start = start.replaceAll("-", "");
                }
                try {
                    end = simpleDateFormat.format(Long.parseLong(fdaQueryCondition.getReportEndTime())).replaceAll("-", "");
                } catch (NumberFormatException e) {
                    end = end.replaceAll("-", "");
                }
            }
            drugSafeDto.setIsShowUnknown(fdaQueryCondition.getIsShowUnknown());
            drugSafeDto.setAge(getJdParam(fdaQueryCondition.getAge()));
            drugSafeDto.setADRSAccurate("false");
            drugSafeDto.setBeginDate(ObjectUtils.isNotEmpty(fdaQueryCondition.getReportStartTime()) ? start : "");
            drugSafeDto.setEndDate(ObjectUtils.isNotEmpty(fdaQueryCondition.getReportEndTime()) ? end : "");
            drugSafeDto.setDrugNamesAccurate("false");
            drugSafeDto.setUserDrugNames(getDrugEnglishNamePlus(userSynonm).replaceAll(";", "&&").replaceAll(",", "||"));
            if (StringUtils.isEmpty(drugSafeDto.getUserDrugNames())) {
                drugSafeDto.setUserDrugNames(fdaQueryCondition.getDrugName().replaceAll(";", "&&").replaceAll(",", "||"));
            }
            if (StringUtils.isEmpty(drugSafeDto.getUserDrugNames())) {
                drugSafeDto.setUserDrugNames(drugName.replaceAll(";", "&&").replaceAll(",", "||"));
                //不良反应搜药，只传药
            }
            String s = getJdParam(fdaQueryCondition.getSex()).replaceAll("男", "男性");
            s = s.replaceAll("女", "女性");
            drugSafeDto.setSex(s);
            drugSafeDto.setUserADRS(getptEnglishNamePlusJd(userSynonm).replaceAll(";", "&&").replaceAll(",", "||"));
            drugSafeDto.setUserId(sysUser.getUserId());
            drugSafeDto.setRoleCode(getJdParam(fdaQueryCondition.getRole()));
            drugSafeDto.setOutcCode(getJdParam(fdaQueryCondition.getSeriousOutcome()));
            drugSafeDto.setOccpCode(getJdParam(fdaQueryCondition.getCareer()));
            drugSafeDto.setUserIndications(listToString(fdaQueryCondition.getIndication()));
            drugSafeDto.setSearchID(searchId);
            log.info("安全性分析查询条件:{}", drugSafeDto);
            Update update = new Update();
            update.set("searchDataJd", drugSafeDto);
            update.set("reportStartTime", fdaQueryCondition.getReportStartTime());
            update.set("reportEndTime", fdaQueryCondition.getReportEndTime());
            update.set("jdFdaQuery", JSONObject.toJSON(fdaQueryCondition));
            Query query = new Query(Criteria.where("_id").is(fdaQueryCondition.getId()));
            mongoTemplate.updateFirst(query, update, "drug_adrs_search_data");
        }
        JSONObject res;
        try {
            res = JSONObject.parseObject(this.dataFeign.getDataJd(drugSafeDto));
        } catch (Exception e) {
            res = new JSONObject();
            //坑
            res.put("data", new JSONObject());
        }

        log.info("安全性分析查询结果：{}", res);
        JSONObject data = res.getJSONObject("data");
        if (CollectionUtil.isNotEmpty(data)) {
            data.put("drugName", Collections.singletonList(fdaQueryCondition.getDrugName()));
        }
        data.put("id", searchId);
        return data;
    }


    private FdaQueryCondition initCondition(String id) {
        JSONObject userSynonym = this.mongoTemplate.findOne(new Query(Criteria.where("id").is(id)), JSONObject.class, "drug_adrs_search_data");
        JSONObject userSynonymSupplement = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data_supplement");
        StringBuilder drugName = new StringBuilder();
        if (userSynonym == null) {
            userSynonym = this.mongoTemplate.findById(id, JSONObject.class, "drug_adrs_search_data");
            //userSynonym = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
            if (userSynonym == null) {
                throw new RuntimeException("search synonym not found");
            }
        }

        JSONArray jsonArray = userSynonym.getJSONArray("drugs");
        List<String> pt = new ArrayList<>();
        if (userSynonym != null) {
            JSONArray jsonArraySupplement = userSynonym.getJSONArray("pts");
            for (JSONArray jsonArray1 : jsonArraySupplement.toJavaList(JSONArray.class)) {
                for (JSONObject jsonObject : jsonArray1.toJavaList(JSONObject.class)) {
                    String word = jsonObject.getString("word");
                    String trans = jsonObject.getString("trans");
                    if (!isChinese(word)) {
                        pt.add(trans);
                    } else {
                        pt.add(word);
                    }
                }
            }
        }
        List<String> drug = new ArrayList<>();
        for (JSONArray jsonArray1 : jsonArray.toJavaList(JSONArray.class)) {
            for (JSONObject jsonObject : jsonArray1.toJavaList(JSONObject.class)) {
                drugName.append(",").append(jsonObject.getString("word"));

            }
            drug.add(jsonArray1.getJSONObject(0).getString("word"));
        }

            /*if ("pt".equals(jsonObject.getString("type"))) {
                pt.add(jsonObject.getString("word"));
            }*/

        //
        FdaQueryCondition fdaQueryCondition = new FdaQueryCondition();
        fdaQueryCondition.setId(id);
        fdaQueryCondition.setDrugName(getDrugEnglishNamePlus(userSynonym));
        fdaQueryCondition.setPt(pt);
        fdaQueryCondition.setDrug(drug);
        return fdaQueryCondition;
    }

    private DrugAlert transDrugAlert(JSONObject queryResult) {
        Boolean aBoolean;
        try {
            aBoolean = queryResult.getJSONObject("signal_dict").getBoolean("outcome");
        } catch (Exception e) {
            aBoolean = false;
        }
        if (Objects.isNull(aBoolean)) {
            aBoolean = false;
        }
        if (queryResult.getJSONObject("signal_dict") != null && !aBoolean) {
            JSONObject signalDict = queryResult.getJSONObject("signal_dict").getJSONObject("data1");
            if (signalDict == null) {
                signalDict = queryResult.getJSONObject("signal_dict").getJSONObject("data");
            }
            JSONObject signalDict2 = queryResult.getJSONObject("signal_dict").getJSONObject("data2");
            JSONObject signalDict3 = queryResult.getJSONObject("signal_dict").getJSONObject("data3");
            JSONObject signalDict4 = queryResult.getJSONObject("signal_dict").getJSONObject("data4");
            queryResult.put("signal_dict", signalDict);
            queryResult.put("signal_dict2", signalDict2);
            queryResult.put("signal_dict3", signalDict3);
            queryResult.put("signal_dict4", signalDict4);

        } else {
            queryResult.put("signal_dict", new HashMap<>());
        }
        queryResult = JSONObject.parseObject(JSON.toJSONString(MapKeyConverter.convertKeysToCamelCase(queryResult)));
        DrugAlert drugAlert = queryResult.toJavaObject(DrugAlert.class);
        Map<String, List<List<String>>> stringListMap = new HashMap<>();
        Map<String, List<List<String>>> signalDict = drugAlert.getSignalDict();
        if (signalDict != null) {
            signalDict.entrySet().forEach(
                    entry -> {
                        List<List<String>> lists = new ArrayList<>();
                        for (List<String> list : entry.getValue()) {
                            if (Integer.parseInt(list.get(1)) > 3) {
                                lists.add(list);
                            }
                            stringListMap.put(entry.getKey(), lists);
                        }
                    }
            );
        }
        drugAlert.setId(queryResult.getString("id"));
        drugAlert.setSignalDict(stringListMap);
        try {
            drugAlert.setDrugName(queryResult.getJSONArray("drugName").toJavaList(String.class));
        } catch (Exception e) {
            drugAlert.setDrugName(new ArrayList<>());
        }

        return drugAlert;
    }

    @Override
    public JSONObject getFdaSearhConditon(String id, String drugName) {
        FdaQueryCondition fdaQueryCondition = initCondition(id);
        JSONObject res = new JSONObject();
        res.put("pt", fdaQueryCondition.getPt());
        res.put("indication", new ArrayList<>());
        if (fdaQueryCondition.getDrug().size() < 1) {
            Object word = new JSONObject().put("word", drugName);
            fdaQueryCondition.getDrug().add(drugName);
            Update update = new Update();
            update.set("drugs", new ArrayList<>().add(word));
            mongoTemplate.updateFirst(new Query(Criteria.where("_id").is(id)), update, "drug_adrs_search_data");
        } else {
            res.put("drugName", fdaQueryCondition.getDrugName());
        }
        int combination = 0;
        if (fdaQueryCondition.getDrug().size() == 1 && fdaQueryCondition.getPt().size() < 1) {
            combination = 0;
        } else if (fdaQueryCondition.getDrug().size() == 1 && fdaQueryCondition.getPt().size() > 0) {
            combination = 1;
        } else if (fdaQueryCondition.getDrug().size() > 1 && fdaQueryCondition.getPt().size() < 1) {
            combination = 2;
        } else if (fdaQueryCondition.getDrug().size() > 1 && fdaQueryCondition.getPt().size() > 0) {
            combination = 3;
        }
        // 0 单药 1 联用药
        res.put("combination", combination);
        /*JSONObject queryResult =query(fdaQueryCondition);
        queryResult.put("drugName", Collections.singletonList(fdaQueryCondition.getDrugName()));
        DrugAlert drugAlert = transDrugAlert(queryResult);
        List<List<String>> indiPtList = drugAlert.getIndiPtList();
        try {
            indiPtList.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
        }catch (Exception e){
            log.error(e.getMessage(),e);
        }
        for (List<String> indiPt : indiPtList) {
            if(StrUtil.isNotBlank(indiPt.get(4)) && res.getJSONArray("indication").size() <= 10 ) {
                res.getJSONArray("indication").add(indiPt.get(4));
            }
        }*/
        String start = "";
        String end = "";
        if (ObjectUtils.isNotEmpty(fdaQueryCondition.getReportStartTime())) {
            SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
            start = simpleDateFormat.format(Long.parseLong(fdaQueryCondition.getReportStartTime())).replaceAll("-", "");
            end = simpleDateFormat.format(Long.parseLong(fdaQueryCondition.getReportEndTime())).replaceAll("-", "");
        }
        SafeInfoDto drugSafeDto = new SafeInfoDto();
        drugSafeDto.setAge(getSomParam(fdaQueryCondition.getAge(), Arrays.asList("儿童", "成人", "老年人")));
        drugSafeDto.setADRSAccurate("false");
        drugSafeDto.setBeginDate(start);
        drugSafeDto.setEndDate(end);
        drugSafeDto.setDrugNamesAccurate("false");
        drugSafeDto.setBasicSearch("true");
        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(fdaQueryCondition.getId())), JSONObject.class, "drug_adrs_search_data");
        assert userSynonm != null;
        drugSafeDto.setUserDrugNames(getDrugEnglishNamePlus(userSynonm).replaceAll(";", "&&").replaceAll(",", "||"));
        drugSafeDto.setSex(getSomParam(fdaQueryCondition.getSex(), Arrays.asList("M", "F", "UNK")));
        drugSafeDto.setUserADRS(translateList(fdaQueryCondition.getPt()));
        drugSafeDto.setRoleCode(getSomParam(fdaQueryCondition.getRole(), Arrays.asList("相互作用", "SS", "C", "I")));
        drugSafeDto.setOutcCode(getSomParam(fdaQueryCondition.getSeriousOutcome(), Arrays.asList("DE", "LT", "HO", "DS", "CA", "RI", "OT")));
        drugSafeDto.setOccpCode(getSomParam(fdaQueryCondition.getCareer(), Arrays.asList("MD", "PH", "OT", "LW", "CN")));
        drugSafeDto.setUserIndications(translateList(fdaQueryCondition.getIndication()));
        String indication = getIndicationWithRetry(drugSafeDto,3,1000);
        if (StringUtils.isNotBlank(indication)) {
            JSONObject jsonObject = JSONObject.parseObject(indication);
            JSONArray data = jsonObject.getJSONArray("data");
            // 添加空值检查
            if (data != null && !data.isEmpty()) {
                //过滤ptEn为空或者null的数据
                data.forEach(item -> {
                    JSONObject itemObject = (JSONObject) item;
                    if (itemObject.getString("ptEn") != null && !"".equals(itemObject.getString("ptEn"))) {
                        res.getJSONArray("indication").add(itemObject);
                    }
                });
            }
        }
        String searchId = fdaQueryCondition.getId();
        if (!"1".equals(userSynonm.getString("route"))) {
            String screenQuery = "{\"generalOrFineScreen\":\"阿司匹林\",\"screenId\":null,\"screenMap\":null,\"excludeSynonyms\":null,\"translateStatus\":1,\"type\":1,\"retain\":false}";
            ScreenRequest screenRequest = JSONObject.parseObject(screenQuery, ScreenRequest.class);
            screenRequest.setGeneralOrFineScreen(drugName);
            JSONObject screen = this.fineScreenFeign.screen(screenRequest);
            searchId = screen.getJSONObject("data").getString("screenId");
            Update update = new Update();
            update.set("_id", searchId);
            Query query = new Query(Criteria.where("_id").is(fdaQueryCondition.getId()));
            mongoTemplate.updateFirst(query, update, "drug_adrs_search_data");
        }
        res.put("id", searchId);

        return res;
    }

    public String getIndicationWithRetry(SafeInfoDto drugSafeDto, int maxAttempts, long delay) {
        int attempt = 0;
        Exception lastException = null;

        while (attempt < maxAttempts) {
            try {
                return dataFeign.getIndication(drugSafeDto);
            } catch (Exception e) {
                lastException = e;
                attempt++;
                if (attempt < maxAttempts) {
                    try {
                        Thread.sleep(delay);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw new RuntimeException("Thread interrupted", ie);
                    }
                }
            }
        }

        // 如果所有重试都失败了，抛出最后一次捕获的异常
        throw new RuntimeException("Failed to get indication after " + maxAttempts + " attempts", lastException);
    }


    @Override
    public JSONObject getFdaSearhConditonJd(String id, String drugName) {
        FdaQueryCondition fdaQueryCondition = initCondition(id);
        JSONObject res = new JSONObject();
        res.put("pt", fdaQueryCondition.getPt());
        res.put("indication", new ArrayList<>());
        if (fdaQueryCondition.getDrug().size() < 1) {
            Object word = new JSONObject().put("word", drugName);
            fdaQueryCondition.getDrug().add(drugName);
            Update update = new Update();
            update.set("drugs", new ArrayList<>().add(word));
            mongoTemplate.updateFirst(new Query(Criteria.where("_id").is(id)), update, "drug_adrs_search_data");
        } else {
            res.put("drugName", fdaQueryCondition.getDrugName());
        }
        int combination = 0;
        if (fdaQueryCondition.getDrug().size() == 1 && fdaQueryCondition.getPt().size() < 1) {
            combination = 0;
        } else if (fdaQueryCondition.getDrug().size() == 1 && fdaQueryCondition.getPt().size() > 0) {
            combination = 1;
        } else if (fdaQueryCondition.getDrug().size() > 1 && fdaQueryCondition.getPt().size() < 1) {
            combination = 2;
        } else if (fdaQueryCondition.getDrug().size() > 1 && fdaQueryCondition.getPt().size() > 0) {
            combination = 3;
        }
        // 0 单药 1 联用药
        res.put("combination", combination);
        /*JSONObject queryResult =query(fdaQueryCondition);
        queryResult.put("drugName", Collections.singletonList(fdaQueryCondition.getDrugName()));
        DrugAlert drugAlert = transDrugAlert(queryResult);
        List<List<String>> indiPtList = drugAlert.getIndiPtList();
        try {
            indiPtList.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
        }catch (Exception e){
            log.error(e.getMessage(),e);
        }
        for (List<String> indiPt : indiPtList) {
            if(StrUtil.isNotBlank(indiPt.get(4)) && res.getJSONArray("indication").size() <= 10 ) {
                res.getJSONArray("indication").add(indiPt.get(4));
            }
        }*/
        String start = "";
        String end = "";
        if (ObjectUtils.isNotEmpty(fdaQueryCondition.getReportStartTime())) {
            SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
            start = simpleDateFormat.format(Long.parseLong(fdaQueryCondition.getReportStartTime())).replaceAll("-", "");
            end = simpleDateFormat.format(Long.parseLong(fdaQueryCondition.getReportEndTime())).replaceAll("-", "");
        }
        SafeInfoDto drugSafeDto = new SafeInfoDto();
        drugSafeDto.setAge(getJdParam(fdaQueryCondition.getAge()));
        drugSafeDto.setADRSAccurate("false");
        drugSafeDto.setBeginDate(start);
        drugSafeDto.setEndDate(end);
        drugSafeDto.setDrugNamesAccurate("false");
        drugSafeDto.setBasicSearch("true");
        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(fdaQueryCondition.getId())), JSONObject.class, "drug_adrs_search_data");
        assert userSynonm != null;
        drugSafeDto.setUserDrugNames(getDrugEnglishNamePlus(userSynonm).replaceAll(";", "&&").replaceAll(",", "||"));
        drugSafeDto.setSex(getJdParam(fdaQueryCondition.getSex()));
        drugSafeDto.setUserADRS(getptEnglishNamePlusJd(userSynonm).replaceAll(";", "&&"));
        drugSafeDto.setRoleCode(getJdParam(fdaQueryCondition.getRole()));
        drugSafeDto.setOutcCode(getJdParam(fdaQueryCondition.getSeriousOutcome()));
        drugSafeDto.setOccpCode(getJdParam(fdaQueryCondition.getCareer()));
        drugSafeDto.setUserIndications(translateList(fdaQueryCondition.getIndication()));
        String indication = dataFeign.getIndicationJd(drugSafeDto);
        if (StringUtils.isNotBlank(indication)) {
            JSONObject jsonObject = JSONObject.parseObject(indication);
            res.getJSONArray("indication").addAll(jsonObject.getJSONArray("data"));
        }else {
            res.getJSONArray("indication").add("未知");
        }
        String searchId = fdaQueryCondition.getId();
        if (!"1".equals(userSynonm.getString("route"))) {
            String screenQuery = "{\"generalOrFineScreen\":\"阿司匹林\",\"screenId\":null,\"screenMap\":null,\"excludeSynonyms\":null,\"translateStatus\":1,\"type\":1,\"retain\":false}";
            ScreenRequest screenRequest = JSONObject.parseObject(screenQuery, ScreenRequest.class);
            screenRequest.setGeneralOrFineScreen(drugName);
            JSONObject screen = this.fineScreenFeign.screen(screenRequest);
            searchId = screen.getJSONObject("data").getString("screenId");
            Update update = new Update();
            update.set("_id", searchId);
            Query query = new Query(Criteria.where("_id").is(fdaQueryCondition.getId()));
            mongoTemplate.updateFirst(query, update, "drug_adrs_search_data");
        }
        res.put("id", searchId);

        return res;
    }

    @Transactional
    @Override
    public void saveUserSynonym(JSONObject jsonObject) {
        String id = jsonObject.getString("id");
        this.mongoTemplate.remove(new Query(Criteria.where("id").is(id)), "drug_adrs_search_data");
        this.mongoTemplate.insert(jsonObject, "drug_adrs_search_data");
    }

    @Override
    public JSONObject getSynonymById(String id) {
        return this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
    }


    private List<String> getSynonym(String str) {
        JSONObject result = fineScreenFeign.getSynonyms(str);
        List<String> ans = new ArrayList<>();
        if (result != null) {
            result = result.getJSONObject("data");
            if (CollectionUtil.isNotEmpty(result.getJSONArray("synonym"))) {
                JSONArray synonym = result.getJSONArray("synonym");
                for (JSONObject jsonObject : synonym.toJavaList(JSONObject.class)) {
                    ans.add(jsonObject.getString("name"));
                }
            }
        }
        return ans;
    }

    private String render(String str, Map<String, String> renderData) {
        String[] arr = str.split("；");
        StringBuilder sb = new StringBuilder();
        for (String s : arr) {
            boolean flag = false;
            for (Map.Entry<String, String> entry : renderData.entrySet()) {
                if (s.contains(entry.getKey())) {
                    flag = true;
                    break;
                }
            }
            if (flag) {
                sb.append(s);
            }
        }
        String ss = sb.toString();
        for (Map.Entry<String, String> entry : renderData.entrySet()) {
            ss = ss.replaceAll("#\\{" + entry.getKey() + "}", entry.getValue());
        }
        return ss;
    }

    @Override
    public JSONObject getReport(String id, String drugNameOut) {
        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
        assert userSynonm != null;
        String drugName = getDrugEnglishName(userSynonm);
        if (StringUtils.isEmpty(drugName)) {
            drugName = drugNameOut;
        }
        FdaQueryCondition fdaQueryCondition1 = initCondition(id);
        fdaQueryCondition1.setIsOldTable(true);
        JSONObject ans = new JSONObject();
        JSONObject queryData = query(fdaQueryCondition1, drugName);
        log.info(queryData.toString());
        String pt = getDrugEngPt(userSynonm);
        //单药
        if (StrUtil.isBlank(pt) && !drugName.contains(",")) {
            ans.put("type", 0);
            //单药 + 不良反应
        } else if (StrUtil.isNotBlank(pt) && !drugName.contains(",")) {
            ans.put("type", 1);
            //联合
        } else if (StrUtil.isBlank(pt) && drugName.contains(",")) {
            ans.put("type", 2);
            //联合加不良反应
        } else if (StrUtil.isNotBlank(pt) && drugName.contains(",")) {
            ans.put("type", 3);
        }
        drugName = drugName.replaceAll(";", "/");
        drugName = drugName.replaceAll(",", "联合");

        if(StringUtils.isEmpty(pt)){
            ans.put("loadName",drugName+"安全性分析报告");
            ans.put("titleName","基于美国FAERS数据库的"+drugName+"不良事件信号挖掘");
        }else {
            ans.put("loadName",drugName+"导致"+pt+"安全性分析报告");
            ans.put("titleName","基于美国FAERS数据库的"+drugName+"导致"+pt+"不良事件信号挖掘");
        }

        String dateStart = "2004-01-01";
        String dateEnd = configUtil.getConfig(ConfigEnum.FEARS_END_DATE);
        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
        if (ObjectUtils.isNotEmpty(userSynonm.getString("reportStartTime"))) {
            dateStart = simpleDateFormat.format(Long.parseLong(userSynonm.getString("reportStartTime")));
        }
        if (ObjectUtils.isNotEmpty(userSynonm.getString("reportEndTime"))) {
            dateEnd = simpleDateFormat.format(Long.parseLong(userSynonm.getString("reportEndTime")));
        }

        ans.put("strategy", new JSONObject());
        ans.getJSONObject("strategy").put("drugName", drugName);
        ans.getJSONObject("strategy").put("database", "FAERS不良反应数据库");
        ans.getJSONObject("strategy").put("queryData", dateStart + " 至 " + dateEnd);
        ans.getJSONObject("strategy").put("pt", getDrugEngPt(userSynonm));
        ans.put("result", new JSONObject());
        ans.getJSONObject("result").put("totalCase", 0);
        ans.getJSONObject("result").put("summary", "基于以上检索策略：在FAERS数据库共得到相关报告" + 0 + "例。");
        if (queryData == null) {
            queryData = new JSONObject();
        }
        long totalCase = 0;
        JSONArray year_list = queryData.getJSONArray("year_list");

        if (CollectionUtil.isNotEmpty(year_list)) {
            for (JSONArray year : year_list.toJavaList(JSONArray.class)) {
                totalCase += year.getLong(2);
            }
        }
        ans.getJSONObject("result").put("totalCase", totalCase);
        ans.getJSONObject("result").put("summary", "基于以上检索策略：在FAERS数据库共得到相关报告" + totalCase + "例。其分析结果如下：");

        JSONObject o = userSynonm.getJSONObject("fdaQuery");
        FdaQueryCondition fdaQueryCondition = JSONObject.parseObject(o.toString(), FdaQueryCondition.class);
        //年龄段
        List<String> age = fdaQueryCondition.getAge();
        //担任角色
        List<String> role = fdaQueryCondition.getRole();
        //适应症
        List<String> indication = fdaQueryCondition.getIndication();
        //结局
        List<String> seriousOutcome = fdaQueryCondition.getSeriousOutcome();
        //性别
        List<String> sex = fdaQueryCondition.getSex();
        //是否展示
        String isShowUnknown = fdaQueryCondition.getIsShowUnknown();
        //上报职业
        List<String> career = fdaQueryCondition.getCareer();
        //检索时间

        ArrayList<String> summeryTatle = new ArrayList<>();
        summeryTatle.add("本研究数据来源于FAERS数据库，该数据库中的药品ADE信息由患者或卫生健康系统人员自主上报，每季度更新 1 次。目前数据库已更新至"+configUtil.getConfig(ConfigEnum.FEARS_END_JD)+"。");
        //检索时间
        summeryTatle.add("本研究提取了" + dateStart + "至" + dateEnd + "的ADE报告数据，进行回顾性药物警戒研究。由于数据每季度更新，患者上报信息可能发生变化，不可避免会和之前已公开的报告重复，故需要根据公布的删除文件进行去重处理。根据FDA的建议，当CASEID相同时选择最新的FDA_DT，当CASEID与FDA_DT都相同时选择更高的PRIMARYID，再删除重复病例。");
        //匹配信息
        StringBuilder stringBuilder = new StringBuilder();
        stringBuilder.append("在“drug name”或“prod_ai”进行");
        stringBuilder.append("1".equals(userSynonm.getString("isVague")) ? "模糊" : "精准");
        stringBuilder.append("匹配，限定“");
        stringBuilder.append(drugName);
        stringBuilder.append("”，“role_cod”为");
        for (String s : getRole(role)) {
            stringBuilder.append(s);
            stringBuilder.append("、");
        }
        stringBuilder.delete(stringBuilder.length() - 1, stringBuilder.length());
        stringBuilder.append("；从中筛选出相关ADE报告。");
        summeryTatle.add(stringBuilder.toString());
        summeryTatle.add("您选择的其他筛选条件为 ：");
        summeryTatle.add("未知数据：" + ("0".equals(isShowUnknown) ? "不展示" : "展示"));
        if (userSynonm.getIntValue("type") == 1 || userSynonm.getIntValue("type") == 3) {
            summeryTatle.add("不良反应: " + pt);
        }
        if (!indication.contains("不限")) {
            StringBuilder stringBuilder1 = new StringBuilder();
            stringBuilder1.append("适应症：");
            for (String s : indication) {
                JSONObject ptAllData = mongoTemplate.findOne(new Query(Criteria.where("pt_en").is(s)), JSONObject.class, "pt_all_data");
                String ptCh = "";
                if (ptAllData != null) {
                    ptCh = ptAllData.getString("pt_ch");
                } else if ("unknown".equals(s)) {
                    ptCh = "未知";
                }
                stringBuilder1.append(ptCh + "（" + s + "）");
                stringBuilder1.append("、");
            }

            stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
            summeryTatle.add(stringBuilder1.toString());

        }

        if (!seriousOutcome.contains("不限")) {
            StringBuilder stringBuilder1 = new StringBuilder();
            stringBuilder1.append("严重不良反应结局：");
            for (String s : seriousOutcome) {
                stringBuilder1.append(DownloadServiceImpl.MY_OUTCOME_MAP.get(s));
                stringBuilder1.append("、");
            }
            stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
            summeryTatle.add(stringBuilder1.toString());

        }
        if (!age.contains("不限")) {
            StringBuilder stringBuilder1 = new StringBuilder();
            stringBuilder1.append("年龄：");
            for (String s : age) {
                if ("成人".equals(s)) {
                    stringBuilder1.append("成人（18-64岁）");
                } else if ("儿童".equals(s)) {
                    stringBuilder1.append("儿童（≤18岁）");
                } else if ("老年人".equals(s)) {
                    stringBuilder1.append("老年人（≥65岁）");
                }
                stringBuilder1.append("、");
            }
            stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
            summeryTatle.add(stringBuilder1.toString());

        }

        if (!sex.contains("不限")) {
            StringBuilder stringBuilder1 = new StringBuilder();
            stringBuilder1.append("性别：");
            for (String s : sex) {
                stringBuilder1.append(s);
                stringBuilder1.append("、");
            }
            stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
            summeryTatle.add(stringBuilder1.toString());
        }

        if (!career.contains("不限")) {
            StringBuilder stringBuilder1 = new StringBuilder();
            stringBuilder1.append("职业：");
            for (String s : career) {
                stringBuilder1.append(DownloadServiceImpl.MY_CAREER_MAP.get(s));
                stringBuilder1.append("、");
            }
            stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
            summeryTatle.add(stringBuilder1.toString());

        }

        summeryTatle.add("方法学内容详见附录。");
        ans.getJSONObject("result").put("summaryPlus", summeryTatle);
        ans.getJSONObject("result").put("baseInfo", new JSONObject());
        ans.getJSONObject("result").getJSONObject("baseInfo").put("table1", new JSONObject());
        ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").put("title", "表1  人口学特征及严重不良事件构成情况");
        ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").put("data", new JSONArray());

        JSONArray sex_list = queryData.getJSONArray("sex_m_f");
        Map<String, String> renderData = new HashMap<>();

        if (CollUtil.isNotEmpty(sex_list)) {

            JSONObject sexHead = new JSONObject();
            sexHead.put("tag", "性别");
            sexHead.put("info", "");
            sexHead.put("case", "");
            sexHead.put("rate", "");

            ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(sexHead);

            List<List<String>> sex_ll = new ArrayList<>();
            for (JSONArray jsonArray : sex_list.toJavaList(JSONArray.class)) {
                sex_ll.add(jsonArray.toJavaList(String.class));
            }
            sex_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            for (List<String> l : sex_ll) {
                JSONObject sextable = new JSONObject();
                sextable.put("info", l.get(1));
                sextable.put("case", l.get(2));
                sextable.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(sextable);
            }
            try {
                renderData.put("sex1", sex_ll.get(1).get(1));
                renderData.put("sex1Rate", sex_ll.get(1).get(3));
                renderData.put("sex2", sex_ll.get(0).get(1));
                renderData.put("sex2Rate", sex_ll.get(0).get(3));
            } catch (Exception e) {
                e.printStackTrace();
            }

        }


        JSONArray age_list = queryData.getJSONArray("age_list");


        if (CollectionUtil.isNotEmpty(age_list)) {
            JSONObject ageHead = new JSONObject();
            ageHead.put("tag", "年龄");
            ageHead.put("info", "");
            ageHead.put("case", "");
            ageHead.put("rate", "");

            ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(ageHead);
            List<List<String>> age_ll = new ArrayList<>();
            for (JSONArray jsonArray : age_list.toJavaList(JSONArray.class)) {
                age_ll.add(jsonArray.toJavaList(String.class));
            }

            String[] order = {"≤18岁", "18<年龄<65", "≥65岁", "未知"};
            //比较器的map
            Map<String, Integer> orderMap = new HashMap<>();
            for (int i = 0; i < order.length; i++) {
                orderMap.put(order[i], i);
            }
            // 自定义比较器
            Comparator<List<String>> customComparator = (list1, list2) -> {
                String key1 = (String) list1.get(1);
                String key2 = (String) list2.get(1);
                return Integer.compare(orderMap.getOrDefault(key1, order.length), orderMap.getOrDefault(key2, order.length));
            };
            List<List<String>> sortedAgeList = age_ll.stream()
                    .sorted(customComparator)
                    .collect(Collectors.toList());
            for (List<String> l : sortedAgeList) {
                JSONObject agex = new JSONObject();
                agex.put("info", l.get(1));
                agex.put("case", l.get(2));
                agex.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(agex);
            }
            renderData.put("age1", age_ll.get(0).get(1));
            renderData.put("age1Rate", age_ll.get(0).get(3));
        }
        JSONObject countryHead = new JSONObject();
        countryHead.put("tag", "报告国家");
        countryHead.put("info", "");
        countryHead.put("case", "");
        countryHead.put("rate", "");
        ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(countryHead);

        JSONArray country_list = queryData.getJSONArray("reporter_country_list");

        if (CollectionUtil.isNotEmpty(country_list)) {
            List<List<String>> country_ll = new ArrayList<>();
            // 如果超过五个则截取前五个
            if (country_list.size() > 5) {
                // 修改前：country_list = (JSONArray) country_list.subList(0, 5);
                // 修改后：
                List<Object> subList = country_list.subList(0, 5);
                JSONArray newCountryList = new JSONArray();
                newCountryList.addAll(subList);
                country_list = newCountryList;
            }

            for (JSONArray jsonArray : country_list.toJavaList(JSONArray.class)) {

                country_ll.add(jsonArray.toJavaList(String.class));
            }


            country_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            for (List<String> l : country_ll) {
                JSONObject agex = new JSONObject();
                agex.put("info", l.get(1));
                agex.put("case", l.get(2));
                agex.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(agex);
            }
            renderData.put("country1", country_ll.get(0).get(1));
        }

        JSONArray occp_list = queryData.getJSONArray("occp_cod");
        if (occp_list != null) {
            JSONObject occpHead = new JSONObject();
            occpHead.put("tag", "上报者职业");
            occpHead.put("info", "");
            occpHead.put("case", "");
            occpHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(occpHead);

            List<List<String>> occp_ll = new ArrayList<>();
            for (JSONArray jsonArray : occp_list.toJavaList(JSONArray.class)) {
                occp_ll.add(jsonArray.toJavaList(String.class));
            }
            occp_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            for (List<String> l : occp_ll) {
                JSONObject occp = new JSONObject();
                occp.put("info", l.get(1));
                occp.put("case", l.get(2));
                occp.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(occp);
            }
            try {
                renderData.put("occp1", occp_ll.get(0).get(1));
                renderData.put("occp1Rate", occp_ll.get(0).get(3));
            } catch (IndexOutOfBoundsException e) {
                log.error("occp_ll.get(0).get(1) is null");
            }

        }


        JSONArray outc_code_list = queryData.getJSONArray("outc_code_list");
        if (outc_code_list != null) {

            JSONObject outHead = new JSONObject();
            outHead.put("tag", "严重不良反应事件");
            outHead.put("info", "");
            outHead.put("case", "");
            outHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(outHead);
            List<List<String>> outc_code_ll = new ArrayList<>();
            for (JSONArray jsonArray : outc_code_list.toJavaList(JSONArray.class)) {

                outc_code_ll.add(jsonArray.toJavaList(String.class));
            }

            outc_code_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));

            for (List<String> l : outc_code_ll) {
                JSONObject out = new JSONObject();
                out.put("info", l.get(1));
                out.put("case", l.get(2));
                out.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(out);
            }

            renderData.put("seriours1", outc_code_ll.get(0).get(1));
            renderData.put("seriours1Rate", outc_code_ll.get(0).get(3));
        }

        String baseSummaryTemplate = "在已知的数据中：性别构成上，#{sex1}性（#{sex1Rate}）少于#{sex2}性（#{sex2Rate}）；，年龄主要集中在#{age1}（#{age1Rate}）；，#{country1}报告数最多；，上报者主要为#{occp1}。；严重不良反应结局中以#{seriours1}报告数最多（#{seriours1Rate}）。其人口学特征及严重不良事件构成情况见表 1。不良反应逐年上报情况详见表 2。";
        ans.getJSONObject("result").getJSONObject("baseInfo").put("summary", render(baseSummaryTemplate, renderData));


        ans.getJSONObject("result").getJSONObject("baseInfo").put("table2", new JSONObject());
        ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table2").put("title", "表2  不良反应逐年上报情况");
        ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table2").put("data", new JSONArray());
        JSONArray jsonArray1 = new JSONArray();
        if (CollectionUtil.isNotEmpty(year_list)) {
            for (int i = 0; i < (year_list.size()>=20  ? 20:year_list.size()); i++) {
                JSONObject data = new JSONObject();
                data.put("year", year_list.getJSONArray(i).getString(1));
                data.put("case", year_list.getJSONArray(i).getString(2));
                data.put("rate", year_list.getJSONArray(i).getString(3));
                jsonArray1.add(data);

            }
        }
        jsonArray1.sort((o1, o2) -> {
            int ror1 = Integer.parseInt(JSONObject.parseObject(JSONObject.toJSONString(o1)).getString("year"));
            int ror2 = Integer.parseInt(JSONObject.parseObject(JSONObject.toJSONString(o2)).getString("year"));
            return Integer.compare(ror2, ror1);
        });
        ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table2").put("data", jsonArray1);
        ans.getJSONObject("result").put("drugInfo", new JSONObject());
        ans.getJSONObject("result").getJSONObject("drugInfo").put("table3", new JSONObject());
        ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").put("title", "表3  用药情况");
        ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").put("data", new JSONArray());

        JSONArray dose_from_list = queryData.getJSONArray("dose_from_list");
        if (dose_from_list != null) {
            List<List<String>> dose_from_ll = new ArrayList<>();
            for (JSONArray jsonArray : dose_from_list.toJavaList(JSONArray.class)) {
                dose_from_ll.add(jsonArray.toJavaList(String.class));
            }
            JSONObject doseHead = new JSONObject();
            doseHead.put("tag", "剂型");
            doseHead.put("info", "");
            doseHead.put("case", "");
            doseHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").getJSONArray("data").add(doseHead);
            dose_from_ll.sort((a, b) -> Integer.parseInt(b.get(1)) - Integer.parseInt(a.get(1)));
            renderData.put("dose2", dose_from_ll.get(0).get(3));
            int cnt = 0;
            for (List<String> l : dose_from_ll) {
                JSONObject dose = new JSONObject();
                dose.put("info", l.get(1));
                dose.put("case", l.get(2));
                dose.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").getJSONArray("data").add(dose);
                if ((cnt++) >= 4) {
                    break;
                }
            }
        }

        JSONArray route_list = queryData.getJSONArray("route_list");
        if (CollUtil.isNotEmpty(route_list)) {
            List<List<String>> route_ll = new ArrayList<>();
            for (JSONArray jsonArray : route_list.toJavaList(JSONArray.class)) {
                route_ll.add(jsonArray.toJavaList(String.class));
            }
            JSONObject routeHead = new JSONObject();
            routeHead.put("tag", "给药途径");
            routeHead.put("info", "");
            routeHead.put("case", "");
            routeHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").getJSONArray("data").add(routeHead);
            route_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));

            if (route_ll.get(0).get(1).toLowerCase().startsWith("unknow") && route_ll.size() >= 2) {
                renderData.put("route2", route_ll.get(1).get(4));
            } else {
                renderData.put("route2", route_ll.get(0).get(4));
            }
            int cnt = 0;
            for (List<String> l : route_ll) {
                JSONObject route = new JSONObject();
                route.put("info", l.get(4) + "(" + l.get(1) + ")");
//                mongoTemplate.find(Query.query(Criteria.where("").is(l.get(1))), DrugAnalyzer.class)
                route.put("case", l.get(2));
                route.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").getJSONArray("data").add(route);
                if ((cnt++) >= 4) {
                    break;
                }
            }
        }


        JSONArray dose_amt_list = queryData.getJSONArray("dose_amt_list");
        if (CollUtil.isNotEmpty(dose_amt_list)) {
            JSONObject doseAmtHead = new JSONObject();
            doseAmtHead.put("tag", "给药剂量");
            doseAmtHead.put("info", "");
            doseAmtHead.put("case", "");
            doseAmtHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").getJSONArray("data").add(doseAmtHead);

            List<List<String>> dose_amt_ll = new ArrayList<>();
            for (JSONArray jsonArray : dose_amt_list.toJavaList(JSONArray.class)) {
                dose_amt_ll.add(jsonArray.toJavaList(String.class));
            }
            dose_amt_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            int cnt = 0;
            for (List<String> l : dose_amt_ll) {
                JSONObject amt = new JSONObject();
                amt.put("info", l.get(1));
                amt.put("case", l.get(2));
                amt.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").getJSONArray("data").add(amt);
                if ((cnt++) >= 4) {
                    break;
                }
            }
            if (dose_amt_ll.get(0).get(1).toLowerCase().startsWith("unknow") && dose_amt_ll.size() >= 2) {
                renderData.put("doseamt2", dose_amt_ll.get(1).get(1));
            } else {
                try {
                    renderData.put("route2", dose_amt_ll.get(0).get(4));
                } catch (Exception e) {
                    e.printStackTrace();
                }

            }
        }
        JSONArray dur_list = queryData.getJSONArray("dur_list");
        if (CollectionUtil.isNotEmpty(dur_list)) {
            JSONObject durHead = new JSONObject();
            durHead.put("tag", "持续用药时间");
            durHead.put("info", "");
            durHead.put("case", "");
            durHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").getJSONArray("data").add(durHead);

            List<List<String>> dur_ll = new ArrayList<>();
            for (JSONArray jsonArray : dur_list.toJavaList(JSONArray.class)) {
                dur_ll.add(jsonArray.toJavaList(String.class));
            }
            dur_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            if (dur_ll.get(0).get(1).toLowerCase().startsWith("unknow") && dur_ll.size() >= 2) {
                renderData.put("dur2", dur_ll.get(1).get(1));
            } else {
                renderData.put("dur2", dur_ll.get(0).get(1));
            }
            int cnt = 0;
            for (List<String> l : dur_ll) {
                JSONObject dur = new JSONObject();
                dur.put("info", l.get(1));
                dur.put("case", l.get(2));
                dur.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").getJSONArray("data").add(dur);
                if (cnt >= 4) {
                    break;
                }
                cnt++;
            }
        }

        String template2 = "在已知数据中：该药品报告最多的剂型为#{dose2}，；给药途径报告最多的是#{route2}，；最常用的给药剂量为#{doseamt2}，；该药用药持续时间占比最高的是#{dur2}。详见表 3。";
        ans.getJSONObject("result").getJSONObject("drugInfo").put("summary", render(template2, renderData));
        //indication 写错了携程condition了 结构层次也错了
        ans.getJSONObject("result").put("condition", new JSONObject());
        ans.getJSONObject("result").getJSONObject("condition").put("table4", new JSONObject());
        ans.getJSONObject("result").getJSONObject("condition").getJSONObject("table4").put("data", new JSONArray());
        ans.getJSONObject("result").getJSONObject("condition").getJSONObject("table4").put("title", "表" + (ans.getIntValue("type") <= 1 ? 4 : 3) + "  用药适应症分布情况");


        ans.getJSONObject("result").put("doseRegimenOnsetDistribution", new JSONObject());
        ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").put("table5", new JSONObject());
        ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").put("title", "表" + (ans.getIntValue("type") <= 1 ? 5 : 3) + "  给药方案、不良反应发生时间分布");
        ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").put("data", new JSONArray());

        JSONArray indi_pt_list = queryData.getJSONArray("indi_pt_list");
        if (CollectionUtil.isNotEmpty(indi_pt_list)) {
            List<List<String>> indi_pt_ll = new ArrayList<>();
            for (JSONArray jsonArray : indi_pt_list.toJavaList(JSONArray.class)) {
                indi_pt_ll.add(jsonArray.toJavaList(String.class));
            }
            indi_pt_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            StringBuilder indi = new StringBuilder();
            int indiCursor = 0;
            for (List<String> l : indi_pt_ll) {
                JSONObject dur = new JSONObject();
                dur.put("indication", l.get(4) + "(" + l.get(1) + ")");
                dur.put("case", l.get(2));
                dur.put("rate", l.get(3));
                if (indiCursor >= 5) {
                    break;
                }
                if (!l.get(4).startsWith("未知")) {
                    indi.append(l.get(4)).append(",");
                }
                indiCursor++;
                ans.getJSONObject("result").getJSONObject("condition").getJSONObject("table4").getJSONArray("data").add(dur);
            }

            ans.getJSONObject("result").getJSONObject("condition").put("summary", "在已知数据中：多在" + indi.substring(0, indi.length() - 1) + "等情况下出现了使用。详见表 " + (ans.getIntValue("type") <= 1 ? 4 : 3) + "。");
        }

        JSONArray drug_num_list = queryData.getJSONArray("drug_num_list");
        if (CollectionUtil.isNotEmpty(drug_num_list)) {
            JSONObject drugNumHead = new JSONObject();
            drugNumHead.put("tag", "给药方案");
            drugNumHead.put("affect", "");
            drugNumHead.put("case", "");
            drugNumHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").getJSONArray("data").add(drugNumHead);
            if (drug_num_list != null) {
                for (JSONArray jsonArray : drug_num_list.toJavaList(JSONArray.class)) {

                    if ("联合用药".equals(jsonArray.getString(1))) {
                        renderData.put("联用药比例", jsonArray.getString(3));
                        String substring = jsonArray.getString(3).substring(0, 2);
                        try {
                            if (Integer.parseInt(substring) >= 50) {
                                renderData.put("giveDrug", "联合用药");
                            } else {
                                renderData.put("giveDrug", "单药");
                            }
                        } catch (Exception e) {
                            renderData.put("giveDrug", "单药");
                        }

                    } else {
                        renderData.put("单药药比例", jsonArray.getString(3));
                    }

                    JSONObject drugNum = new JSONObject();
                    drugNum.put("affect", jsonArray.getString(1));
                    drugNum.put("case", jsonArray.getString(2));
                    drugNum.put("rate", jsonArray.getString(3));
                    ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").getJSONArray("data").add(drugNum);
                }
            }
        }


        JSONObject cutHead = new JSONObject();
        cutHead.put("tag", "不良反应发生时间");
        cutHead.put("affect", "");
        cutHead.put("case", "");
        cutHead.put("rate", "");
        ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").getJSONArray("data").add(cutHead);


        JSONArray cut_dt_list = queryData.getJSONArray("cut_dt_list");
        if (CollectionUtil.isNotEmpty(cut_dt_list)) {
            List<List<String>> cut_dt_ll = new ArrayList<>();
            int count = 0;
            for (JSONArray jsonArray : cut_dt_list.toJavaList(JSONArray.class)) {
                cut_dt_ll.add(jsonArray.toJavaList(String.class));
                JSONObject cut = new JSONObject();
                cut.put("affect", jsonArray.getString(1));
                cut.put("case", jsonArray.getString(2));
                cut.put("rate", jsonArray.getString(3));
                ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").getJSONArray("data").add(cut);
                if (count >= 4) {
                    break;
                }
                count++;
            }
            cut_dt_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            if (cut_dt_ll.get(0).get(1).toLowerCase().startsWith("unknow") && cut_dt_ll.size() >= 2) {
                renderData.put("cutdt3", cut_dt_ll.get(1).get(1));
            } else {
                renderData.put("cutdt3", cut_dt_ll.get(0).get(1));
            }
        }
        // ans.getJSONObject("result").put("doseRegimenOnsetDistribution", new JSONObject());
        ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").put("summary", render("给药方案中以#{giveDrug}居多，；不良反应多发生在用药后#{cutdt3}。详见表 5。", renderData));


        ans.getJSONObject("result").put("treatmentAndOutcome", new JSONObject());
        ans.getJSONObject("result").getJSONObject("treatmentAndOutcome").put("summary", "停药或减药后反应减轻或消失的占比为#{停药或减药后反应减轻或消失比例}，反应未减轻或未消失的占比为#{反应未减轻或未消失比例}；，重新用药后反应再次出现的占比为#{重新用药后反应再次出现的占比}。详见表 6");
        ans.getJSONObject("result").getJSONObject("treatmentAndOutcome").put("table6", new JSONObject());
        ans.getJSONObject("result").getJSONObject("treatmentAndOutcome").getJSONObject("table6").put("title", "表" + (ans.getIntValue("type") <= 1 ? 6 : 5) + " 治疗与转归");
        ans.getJSONObject("result").getJSONObject("treatmentAndOutcome").getJSONObject("table6").put("data", new JSONArray());

        for (int i = 0; i < 8; i++) {
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("result", "");
            jsonObject.put("case", "");
            jsonObject.put("rate", "");
            ans.getJSONObject("result").getJSONObject("treatmentAndOutcome").getJSONObject("table6").getJSONArray("data").add(jsonObject);
        }

        int start = 0;
        //重新用药后
        JSONArray rechal = queryData.getJSONArray("rechal");
        if (CollectionUtil.isNotEmpty(rechal)) {
            for (JSONArray jsonArray : rechal.toJavaList(JSONArray.class)) {
                JSONObject jsonObject = new JSONObject();
                jsonObject.put("result", jsonArray.getString(1));
                jsonObject.put("case", jsonArray.getString(2));
                jsonObject.put("rate", jsonArray.getString(3));
                if ("再激发阳性（出现）".equals(jsonArray.getString(1))) {
                    renderData.put("重新用药后反应再次出现的占比", jsonArray.getString(3));
                }
                ans.getJSONObject("result").getJSONObject("treatmentAndOutcome").getJSONObject("table6").getJSONArray("data").set(start++, jsonObject);
            }
        }

        start = 4;

        //停药后
        JSONArray dechal = queryData.getJSONArray("dechal");
        if (CollectionUtil.isNotEmpty(dechal)) {
            for (JSONArray jsonArray : dechal.toJavaList(JSONArray.class)) {
                JSONObject jsonObject = new JSONObject();
                jsonObject.put("result", jsonArray.getString(1));
                jsonObject.put("case", jsonArray.getString(2));
                jsonObject.put("rate", jsonArray.getString(3));
                if ("去激发阳性（减轻、消失）".equals(jsonArray.getString(1))) {
                    renderData.put("停药或减药后反应减轻或消失比例", jsonArray.getString(3));
                } else if ("去激发阴性（未消失或减轻）".equals(jsonArray.getString(1))) {
                    renderData.put("反应未减轻或未消失比例", jsonArray.getString(3));
                }
                ans.getJSONObject("result").getJSONObject("treatmentAndOutcome").getJSONObject("table6").getJSONArray("data").set(start++, jsonObject);
            }
        }

        ans.getJSONObject("result").getJSONObject("treatmentAndOutcome").put("summary", render("停药或减药后反应减轻或消失的占比为#{停药或减药后反应减轻或消失比例}，反应未减轻或未消失的占比为#{反应未减轻或未消失比例}；，重新用药后反应再次出现的占比为#{重新用药后反应再次出现的占比}。详见表 6", renderData));
        ans.put("adverseSignals", new JSONObject());
        ans.getJSONObject("adverseSignals").put("adrsResult", new JSONObject());
        ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").put("table7", new JSONObject());
        ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table7").put("title", "表" + (ans.getIntValue("type") <= 1 ? 7 : 6) + "  ADEs发生频次排序（TOP 10）");
        ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table7").put("data", new JSONArray());

        JSONArray pt_lsit = queryData.getJSONArray("pt_list");
        if (CollectionUtil.isNotEmpty(pt_lsit)) {
            List<List<String>> pt_ll = new ArrayList<>();
            for (JSONArray l : pt_lsit.toJavaList(JSONArray.class)) {
                pt_ll.add(l.toJavaList(String.class));
            }
            pt_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            for (int i = 0; i < pt_ll.size() && i < 10; i++) {
                JSONObject data = new JSONObject();
                data.put("pt", pt_ll.get(i).get(1));
                data.put("badEvent", pt_ll.get(i).get(4));
                data.put("case", pt_ll.get(i).get(2));
                data.put("rate", pt_ll.get(i).get(3));
                ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table7").getJSONArray("data").add(data);
            }
            StringBuilder adrs10 = new StringBuilder();

            for (JSONObject adrs : ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table7").getJSONArray("data").toJavaList(JSONObject.class)) {
                adrs10.append(adrs.getString("badEvent")).append(",");
            }
            ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").put("summary", "表 " + (ans.getIntValue("type") <= 1 ? 7 : 6) + "列出了报告前 " + (ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table7").getJSONArray("data").size()) + " 位的ADEs，包括" + adrs10.substring(0, adrs10.length() - 1) + "。");
        }
        ans.getJSONObject("adverseSignals").put("typicalSignalResult", new JSONObject());
        ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").put("summary", "使用国际医学用语词典（MedDRA）术语集系统器官分类（system organ class,SOC）对有信号的ADEs 进行分类。表6为TOP10的信号以及信号所在的SOC（系统-器官分类）情况。");

        ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").put("table8", new JSONObject());
        ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").put("title", "表" + (ans.getIntValue("type") <= 1 ? 8 : 7) + "  典型信号分析结果");
        ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").put("data", new JSONArray());
        ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").put("data1", new JSONArray());
        ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").put("data2", new JSONArray());
        ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").put("data3", new JSONArray());

        //信号2
        try {
            JSONObject signaldict = queryData.getJSONObject("signal_dict").getJSONObject("data2");

            if (CollectionUtil.isNotEmpty(signaldict)) {
                List<List<String>> signaldictll = new ArrayList<>();
                for (Map.Entry<String, Object> entry : signaldict.entrySet()) {
                    List<List<String>> l = (List<List<String>>) entry.getValue();
                    for (List<String> ll : l) {
                        ll.set(1, String.valueOf(ll.get(1)));
                        if (Integer.parseInt(ll.get(1)) >= 3) {
                            signaldictll.add(ll);
                        }

                    }
                }
                try {
                    signaldictll.sort((o1, o2) -> {
                        double ror1 = Double.parseDouble(o1.get(5));
                        double ror2 = Double.parseDouble(o2.get(5));
                        return Double.compare(ror2, ror1);
                    });
                } catch (Exception e) {
                    e.printStackTrace();
                }
                for (int i = 0; i < signaldictll.size() && i < 10; i++) {
                    List<String> l = signaldictll.get(i);
                    JSONObject signal = new JSONObject();
                    for (Map.Entry<String, Object> entry : signaldict.entrySet()) {
                        List<List<String>> ll = (List<List<String>>) entry.getValue();
                        for (List<String> lll : ll) {
                            if (lll.contains(l.get(6))) {
                                signal.put("soc", entry.getKey() + "/" + l.get(0));
                                break;
                            }
                        }
                    }
                    signal.put("badEvent", l.get(10));
                    signal.put("case", l.get(1));
                    signal.put("rate", l.get(2));
                    signal.put("ror", new BigDecimal(l.get(3)).setScale(2, BigDecimal.ROUND_HALF_UP)+"("+l.get(6)+","+l.get(7)+")");
                    signal.put("ebgm", new BigDecimal(l.get(4)).setScale(2, BigDecimal.ROUND_HALF_UP));
                    signal.put("ic", new BigDecimal(l.get(5)).setScale(2, BigDecimal.ROUND_HALF_UP)+"("+l.get(8)+","+l.get(9)+")");
                    signal.put("rorPro", "("+l.get(6)+","+l.get(7)+")");
                    signal.put("icPro", "("+l.get(8)+","+l.get(9)+")");
                    ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").getJSONArray("data").add(signal);
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }


        //信号2
        try {
            JSONObject signaldict = queryData.getJSONObject("signal_dict").getJSONObject("data2");

            if (CollectionUtil.isNotEmpty(signaldict)) {
                List<List<String>> signaldictll = new ArrayList<>();
                for (Map.Entry<String, Object> entry : signaldict.entrySet()) {
                    List<List<String>> l = (List<List<String>>) entry.getValue();
                    for (List<String> ll : l) {
                        ll.set(1, String.valueOf(ll.get(1)));
                        if (Integer.parseInt(ll.get(1)) >= 3) {
                            signaldictll.add(ll);
                        }

                    }
                }
                try {
                    signaldictll.sort((o1, o2) -> {
                        double ror1 = Double.parseDouble(o1.get(3));
                        double ror2 = Double.parseDouble(o2.get(3));
                        return Double.compare(ror2, ror1);
                    });
                } catch (Exception e) {
                    e.printStackTrace();
                }
                for (int i = 0; i < signaldictll.size() && i < 10; i++) {
                    List<String> l = signaldictll.get(i);
                    JSONObject signal = new JSONObject();
                    for (Map.Entry<String, Object> entry : signaldict.entrySet()) {
                        List<List<String>> ll = (List<List<String>>) entry.getValue();
                        for (List<String> lll : ll) {
                            if (lll.contains(l.get(6))) {
                                signal.put("soc", entry.getKey() + "/" + l.get(0));
                                break;
                            }
                        }
                    }
                    signal.put("badEvent", l.get(10));
                    signal.put("case", l.get(1));
                    signal.put("rate", l.get(2));
                    signal.put("ror", new BigDecimal(l.get(3)).setScale(2, BigDecimal.ROUND_HALF_UP)+"("+l.get(6)+","+l.get(7)+")");
                    signal.put("ebgm", new BigDecimal(l.get(4)).setScale(2, BigDecimal.ROUND_HALF_UP));
                    signal.put("ic", new BigDecimal(l.get(5)).setScale(2, BigDecimal.ROUND_HALF_UP)+"("+l.get(8)+","+l.get(9)+")");
                    signal.put("rorPro", "("+l.get(6)+","+l.get(7)+")");
                    signal.put("icPro", "("+l.get(8)+","+l.get(9)+")");
                    ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").getJSONArray("data1").add(signal);
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }

        //信号3
        try {
            JSONObject signaldict = queryData.getJSONObject("signal_dict").getJSONObject("data3");

            if (CollectionUtil.isNotEmpty(signaldict)) {
                List<List<String>> signaldictll = new ArrayList<>();
                for (Map.Entry<String, Object> entry : signaldict.entrySet()) {
                    List<List<String>> l = (List<List<String>>) entry.getValue();
                    for (List<String> ll : l) {
                        ll.set(1, String.valueOf(ll.get(1)));
                        if (Integer.parseInt(ll.get(1)) >= 3) {
                            signaldictll.add(ll);
                        }

                    }
                }
                try {
                    signaldictll.sort((o1, o2) -> {
                        double ror1 = Double.parseDouble(o1.get(4));
                        double ror2 = Double.parseDouble(o2.get(4));
                        return Double.compare(ror2, ror1);
                    });
                } catch (Exception e) {
                    e.printStackTrace();
                }
                for (int i = 0; i < signaldictll.size() && i < 10; i++) {
                    List<String> l = signaldictll.get(i);
                    JSONObject signal = new JSONObject();
                    for (Map.Entry<String, Object> entry : signaldict.entrySet()) {
                        List<List<String>> ll = (List<List<String>>) entry.getValue();
                        for (List<String> lll : ll) {
                            if (lll.contains(l.get(6))) {
                                signal.put("soc", entry.getKey() + "/" + l.get(0));
                                break;
                            }
                        }
                    }
                    signal.put("badEvent", l.get(10));
                    signal.put("case", l.get(1));
                    signal.put("rate", l.get(2));
                    signal.put("ror", new BigDecimal(l.get(3)).setScale(2, BigDecimal.ROUND_HALF_UP)+"("+l.get(6)+","+l.get(7)+")");
                    signal.put("ebgm", new BigDecimal(l.get(4)).setScale(2, BigDecimal.ROUND_HALF_UP));
                    signal.put("ic", new BigDecimal(l.get(5)).setScale(2, BigDecimal.ROUND_HALF_UP)+"("+l.get(8)+","+l.get(9)+")");
                    signal.put("rorPro", "("+l.get(6)+","+l.get(7)+")");
                    signal.put("icPro", "("+l.get(8)+","+l.get(9)+")");
                    ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").getJSONArray("data2").add(signal);
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }

        //信号2
        try {
            JSONObject signaldict = queryData.getJSONObject("signal_dict").getJSONObject("data2");

            if (CollectionUtil.isNotEmpty(signaldict)) {
                List<List<String>> signaldictll = new ArrayList<>();
                for (Map.Entry<String, Object> entry : signaldict.entrySet()) {
                    List<List<String>> l = (List<List<String>>) entry.getValue();
                    for (List<String> ll : l) {
                        ll.set(1, String.valueOf(ll.get(1)));
                        if (Integer.parseInt(ll.get(1)) >= 3) {
                            signaldictll.add(ll);
                        }

                    }
                }
                try {
                    signaldictll.sort((o1, o2) -> {
                        double ror1 = Double.parseDouble(o1.get(1));
                        double ror2 = Double.parseDouble(o2.get(1));
                        return Double.compare(ror2, ror1);
                    });
                } catch (Exception e) {
                    e.printStackTrace();
                }
                for (int i = 0; i < signaldictll.size() && i < 10; i++) {
                    List<String> l = signaldictll.get(i);
                    JSONObject signal = new JSONObject();
                    for (Map.Entry<String, Object> entry : signaldict.entrySet()) {
                        List<List<String>> ll = (List<List<String>>) entry.getValue();
                        for (List<String> lll : ll) {
                            if (lll.contains(l.get(6))) {
                                signal.put("soc", entry.getKey() + "/" + l.get(0));
                                break;
                            }
                        }
                    }
                    signal.put("badEvent", l.get(10));
                    signal.put("case", l.get(1));
                    signal.put("rate", l.get(2));
                    signal.put("ror", new BigDecimal(l.get(3)).setScale(2, BigDecimal.ROUND_HALF_UP)+"["+l.get(6)+","+l.get(7)+"]");
                    signal.put("ebgm", new BigDecimal(l.get(4)).setScale(2, BigDecimal.ROUND_HALF_UP));
                    signal.put("ic", new BigDecimal(l.get(5)).setScale(2, BigDecimal.ROUND_HALF_UP)+"["+l.get(8)+","+l.get(9)+"]");
                    signal.put("rorPro", "["+l.get(6)+","+l.get(7)+"]");
                    signal.put("icPro", "["+l.get(8)+","+l.get(9)+"]");
                    ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").getJSONArray("data3").add(signal);
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
        String string = userSynonm.getString("prop1");
        ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table8").put("typicalSignal", string);
        ans.getJSONObject("adverseSignals").put("drugADEsTimeChart", new JSONObject());
        ans.getJSONObject("adverseSignals").getJSONObject("drugADEsTimeChart").put("summary", "根据信号检测结果，获得 IC 值居前 3 位的信号，即lactic acidosis（ROR=227.12，IC=6.93) 、hyperlactacidaemia（ROR=96.56，IC=6.02) 、base excess decreased（ROR=284.91，IC=5.96) 。为了考察这3个信号随着时间推移的变化趋势，绘制了近3年lactic acidosis、hyperlactacidaemia、base excess decreased安全信号的时间扫描图谱，结果见图1~3。");
        ans.getJSONObject("adverseSignals").getJSONObject("drugADEsTimeChart").put("images", new JSONArray());
        for (int i = 0; i < 3; i++) {
            JSONObject data = new JSONObject();
            data.put("title", "图1 2020-2022年metformin致lactic acidosis的安全信号的时间扫描图");
            data.put("base64", "xxxxxxx");
            ans.getJSONObject("adverseSignals").getJSONObject("drugADEsTimeChart").getJSONArray("images").add(data);
        }
        StringBuilder regex = new StringBuilder();
        List<JSONObject> policys = new ArrayList<>();
        /*for (String drug : fdaQueryCondition.getDrug()) {
            regex.append(drug).append("|");
        }*/
        //修改政策查询逻辑
        StringBuilder inner = new StringBuilder();
        inner.append("(");
        List<String> drug = fdaQueryCondition1.getDrug();
        if (ObjectUtils.isEmpty(drug)) {
            String[] split = drugNameOut.split(";");
            for (String s : split) {
                drug.add(s);
            }
        }
        for (int i = 0; i < drug.size() - 1; i++) {
            String s = drug.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            inner.append(s).append("|");
        }
        String sOut = drug.get(drug.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        inner.append(sOut);
        inner.append(")");
        regex.append("(?=.*").append(inner).append(")");

        ArrayList<String> strings = new ArrayList<>();
        JSONArray drugs = userSynonm.getJSONArray("drugs");
        for (JSONArray drugx : drugs.toJavaList(JSONArray.class)) {
            for (JSONObject x : drugx.toJavaList(JSONObject.class)) {

                if (StringUtils.isNotEmpty(x.getString("word"))){
                    strings.add(x.getString("word"));
                }
               if  (StringUtils.isNotEmpty(x.getString("trans"))){
                   strings.add(x.getString("trans"));
                 }

            }
        }


        if (CollUtil.isNotEmpty(strings)) {
            // 创建查询对象
            List<Criteria> orConditions = new ArrayList<>();

            // 添加针对 synopsis 字段的或条件
            for (String s : strings) {
                orConditions.add(Criteria.where("synopsis").regex(Pattern.compile(s, Pattern.CASE_INSENSITIVE)));
            }
            Criteria criteria = new Criteria().orOperator(orConditions.toArray(new Criteria[0]));

            Query query = new Query(criteria);
            query.with(Sort.by(Sort.DEFAULT_DIRECTION.DESC, "data_time"));
            List<JSONObject> pharmacovigilance = mongoTemplate.find(query, JSONObject.class, "pharmacovigilance");
            List<Criteria> orConditions2 = new ArrayList<>();
            for (String s : strings) {
                orConditions2.add(Criteria.where("title").regex(Pattern.compile(s, Pattern.CASE_INSENSITIVE)));
            }
            Criteria criteria2 = new Criteria().orOperator(orConditions2.toArray(new Criteria[0]));
            // 创建查询对象
            Query query2 = new Query(criteria2);
            query2.with(Sort.by(Sort.DEFAULT_DIRECTION.DESC, "data_time"));
            List<JSONObject> pharmacovigilanceAdd = mongoTemplate.find(query2, JSONObject.class, "pharmacovigilance");
            StringBuilder stringBuilder1 = new StringBuilder();
            String stringsToRegex = strings.stream()
                    .map(Pattern::quote) // 防止特殊字符影响正则表达式
                    .collect(Collectors.joining("|")); // 使用 "|" 连接各个字符串
            if (pharmacovigilance.size() > 0 || pharmacovigilanceAdd.size() > 0) {
                int x = 0;
                if (pharmacovigilance.size() > 0) {
                    for (int i = 0; i < pharmacovigilance.size(); i++) {
                        String content = "";
                        JSONArray synopsis = pharmacovigilance.get(i).getJSONArray("synopsis");
                        for (String s : synopsis.toJavaList(String.class)) {
                            Pattern pattern = Pattern.compile(stringsToRegex, Pattern.CASE_INSENSITIVE);
                            Matcher matcher = pattern.matcher(s);
                            if (matcher.find()) {
                                content = s;
                            }
                        }
                        String circleNumber = String.valueOf((char) (0x2460 + x)); // 根据索引生成对应带圈数字的字符
                        x++;
                        JSONObject jsonObject1 = new JSONObject();
                        JSONObject jsonObject2 = new JSONObject();
                        jsonObject1.put("title", circleNumber + pharmacovigilance.get(i).getString("title") + "：" + content +
                                "(发布时间：" + pharmacovigilance.get(i).getString("data_time") + ")");
                        jsonObject2.put("title", "原文链接：" + pharmacovigilance.get(i).getString("title_url"));
                        policys.add(jsonObject1);
                        policys.add(jsonObject2);
                    }
                } else {
                    for (int i = 0; i < pharmacovigilanceAdd.size(); i++) {
                        String circleNumber = String.valueOf((char) (0x2460 + x)); // 根据索引生成对应带
                        x++;
                        JSONObject jsonObject1 = new JSONObject();
                        jsonObject1.put("title", circleNumber + pharmacovigilanceAdd.get(i).getString("title") +
                                "(发布时间：" + pharmacovigilanceAdd.get(i).getString("data_time") + ")");
                        JSONObject jsonObject2 = new JSONObject();
                        jsonObject2.put("title", "原文链接：" + pharmacovigilanceAdd.get(i).getString("title_url"));
                        policys.add(jsonObject1);
                        policys.add(jsonObject2);
                    }
                }
                //policys.addAll(this.mongoTemplate.find(new Query(Criteria.where("conent").regex(regex.substring(0, regex.length() - 1), "i")), JSONObject.class, "yaojianju_yaowujingjie"));

            }
        }

        ans.put("policyInfo", policys);
//        try {
//            //查询临床试验//
//            JSONObject cilinicalQuery = JSONObject.parseObject("{\"pageNum\":1,\"pageSize\":200,\"type\":0,\"change\":[1],\"registrationTimeSort\":2,\"endRegistrationTime\":\"\",\"startRegistrationTime\":\"\",\"maxSampleSize\":\"\",\"minSampleSize\":\"\",\"searchData\":\"#{drug}\",\"studyType\":[],\"testPhase\":[]}");
//            cilinicalQuery.put("searchData", userSynonm.getJSONArray("result").getJSONObject(0).getString("word"));
//            JSONObject cilinicalData = this.clinicalTrialFeign.getClinical(cilinicalQuery);
//            JSONArray cilinicals = cilinicalData.getJSONObject("data").getJSONArray("list");
//            ans.put("cilinical_trail", new JSONArray());
//            if (CollectionUtil.isNotEmpty(cilinicals)) {
//                for (JSONObject cilinical : cilinicals.toJavaList(JSONObject.class)) {
//                    String registerNo = cilinical.getString("registerNo");
//                    //判断是否存在不良反应
//                    JSONObject cilinicalAdrs = this.mongoTemplate.findOne(new Query(Criteria.where("register_no").is(registerNo)), JSONObject.class, "clinical_trial_registration_wxm");
//                    if (cilinicalAdrs != null) {
//                        cilinicalAdrs = JSON.parseObject(JSON.toJSONString(cilinicalAdrs, nameFilter));
//                        List<JSONObject> s = cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("SERIOUS_ADVERSE_EVENTS").toJavaList(JSONObject.class);
//                        if (s.size() > 1) {
//                            Map<String, List<JSONObject>> smap = new HashMap<>();
//                            for (JSONObject jsonObject : s) {
//                                String skey = "";
//                                if (jsonObject.containsKey("organ_system")) {
//                                    skey = jsonObject.getString("organ_system");
//                                }
//                                List<JSONObject> l = smap.getOrDefault(skey, new ArrayList<>());
//                                l.add(jsonObject);
//                                smap.put(skey, l);
//                            }
//                            s.clear();
//                            if (smap.get("") != null) {
//                                s.addAll(smap.get(""));
//                            }
//                            for (Map.Entry<String, List<JSONObject>> entry : smap.entrySet()) {
//                                if (entry.getKey().equals("")) {
//                                    continue;
//                                }
//                                JSONObject orga_sys = new JSONObject();
//                                orga_sys.put("tag", entry.getKey());
//                                orga_sys.put("organ_system", entry.getKey());
//                                orga_sys.put("stats", new ArrayList<>());
//
//                                orga_sys.put("assessment_type", "");
//                                orga_sys.put("source_vocabulary", "");
//                                s.add(orga_sys);
//                                s.addAll(entry.getValue());
//                            }
//                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("SERIOUS_ADVERSE_EVENTS").clear();
//                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("SERIOUS_ADVERSE_EVENTS").addAll(s);
//                        }
//
//                        List<JSONObject> ox = cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("OTHER_(NOT_INCLUDING_SERIOUS)_ADVERSE_EVENTS").toJavaList(JSONObject.class);
//                        if (ox.size() > 1) {
//                            Map<String, List<JSONObject>> omap = new HashMap<>();
//                            for (JSONObject jsonObject : ox) {
//                                String skey = "";
//                                if (jsonObject.containsKey("organ_system")) {
//                                    skey = jsonObject.getString("organ_system");
//                                }
//                                List<JSONObject> l = omap.getOrDefault(skey, new ArrayList<>());
//                                l.add(jsonObject);
//                                omap.put(skey, l);
//                            }
//                            ox.clear();
//                            if (omap.get("") != null) {
//                                ox.addAll(omap.get(""));
//                            }
//                            for (Map.Entry<String, List<JSONObject>> entry : omap.entrySet()) {
//                                if (entry.getKey().equals("")) {
//                                    continue;
//                                }
//                                JSONObject orga_sys = new JSONObject();
//                                orga_sys.put("tag", entry.getKey());
//                                orga_sys.put("organ_system", entry.getKey());
//                                orga_sys.put("stats", new ArrayList<>());
//
//                                orga_sys.put("assessment_type", "");
//                                orga_sys.put("source_vocabulary", "");
//                                ox.add(orga_sys);
//                                ox.addAll(entry.getValue());
//                            }
//                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("OTHER_(NOT_INCLUDING_SERIOUS)_ADVERSE_EVENTS").clear();
//                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("OTHER_(NOT_INCLUDING_SERIOUS)_ADVERSE_EVENTS").addAll(ox);
//                        }
//                        cilinicalAdrs.put("register_no", registerNo);
//                        cilinicalAdrs.put("public_title", cilinical.getString("publicTitle"));
//                        cilinicalAdrs.put("interventions", cilinical.getJSONArray("intervention"));
//                        //todo 处理这个
//                        cilinicalAdrs.put("lastUpdatePosted", cilinical.getString("registerDate"));
//                        ans.getJSONArray("cilinical_trail").add(cilinicalAdrs);
//                    }
//                }
//            }
//        } catch (Exception e) {
//            log.debug("临床试验无数据");
//        }
        ans.put("instruction", getInstructions(userSynonm));
        ans.put("references", Arrays.asList("[1]洪东升,倪剑,单文雅,李璐,胡希,羊红玉,赵青威,张幸国.基于监测数据的药物不良反应快速识别及R语言实现[J].浙江大学学报(医学版),2020,49(02):253-259."));
        ans.put("_id", id);
        this.mongoTemplate.remove(new Query(Criteria.where("_id").is(id)), "drug_safe_report");
        this.mongoTemplate.insert(ans, "drug_safe_report");
        return ans;
    }


    @Override
    public JSONObject getReportJd(String id, String drugNameOut) {
        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
        assert userSynonm != null;
        String drugName = getDrugName(userSynonm);
        if (StringUtils.isEmpty(drugName)) {
            drugName = drugNameOut;
        }
        FdaQueryCondition fdaQueryCondition1 = initCondition(id);
        fdaQueryCondition1.setIsOldTable(true);
        JSONObject ans = new JSONObject();
        JSONObject queryData = queryJd(fdaQueryCondition1, drugName);
        JSONArray titleCount = queryData.getJSONArray("titleCount");
        String string1 = queryData.getString("adeTotle");
        List<String> titleCountx = titleCount.toJavaObject(List.class);
        log.info(queryData.toString());
        String pt = getDrugEngPt(userSynonm);
        //单药
        if (StrUtil.isBlank(pt) && !drugName.contains(",")) {
            ans.put("type", 0);
            //单药 + 不良反应
        } else if (StrUtil.isNotBlank(pt) && !drugName.contains(",")) {
            ans.put("type", 1);
            //联合
        } else if (StrUtil.isBlank(pt) && drugName.contains(",")) {
            ans.put("type", 2);
            //联合加不良反应
        } else if (StrUtil.isNotBlank(pt) && drugName.contains(",")) {
            ans.put("type", 3);
        }
        drugName = drugName.replaceAll(";", "/");
        drugName = drugName.replaceAll(",", "联合");

        String dateStart = "2004-01-01";
        String dateEnd = configUtil.getConfig(ConfigEnum.FEARS_END_DATE_JD);
        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
        if (ObjectUtils.isNotEmpty(userSynonm.getString("reportStartTime"))) {
            dateStart = simpleDateFormat.format(Long.parseLong(userSynonm.getString("reportStartTime")));
        }
        if (ObjectUtils.isNotEmpty(userSynonm.getString("reportEndTime"))) {
            dateEnd = simpleDateFormat.format(Long.parseLong(userSynonm.getString("reportEndTime")));
        }


        JSONArray titleCount1 = queryData.getJSONArray("titleCount");

        ans.put("strategy", new JSONObject());
        ans.getJSONObject("strategy").put("drugName", drugName);
        ans.getJSONObject("strategy").put("database", "JADER不良反应数据库");
        ans.getJSONObject("strategy").put("queryData", dateStart + " 至 " + dateEnd);
        ans.getJSONObject("strategy").put("pt", getDrugEngPt(userSynonm));
        ans.getJSONObject("strategy").put("endData",configUtil.getConfig(ConfigEnum.FEARS_END_DATE_JD2));
        ans.put("result", new JSONObject());
        ans.getJSONObject("result").put("totalCase", 0);
        ans.getJSONObject("result").put("summary", "基于以上检索策略：在JADER数据库共得到相关报告" + 0 + "例。");
        if (queryData == null) {
            queryData = new JSONObject();
        }
        long totalCase = 0;
        JSONArray year_list = queryData.getJSONArray("year_list");

        if (CollectionUtil.isNotEmpty(year_list)) {

            ans.put("dataVolume","");
            for (JSONArray year : year_list.toJavaList(JSONArray.class)) {
                totalCase += year.getLong(2);
            }
        }else {
                ans.put("dataVolume","基于以上检索策略：在JADER数据库共得到相关报告0例。");
        }
        ans.getJSONObject("result").put("totalCase", totalCase);
        ans.getJSONObject("result").put("summary", "基于以上检索策略：在JADER数据库共得到相关报告" + totalCase + "例。");

        JSONObject o = userSynonm.getJSONObject("jdFdaQuery");
        if(Objects.isNull(o)){
            o = userSynonm.getJSONObject("fdaQuery");
        }
        FdaQueryCondition fdaQueryCondition = JSONObject.parseObject(o.toString(), FdaQueryCondition.class);
        //年龄段
        List<String> age = fdaQueryCondition.getAge();
        //担任角色
        List<String> role = fdaQueryCondition.getRole();
        //适应症
        List<String> indication = fdaQueryCondition.getIndication();
        //结局
        List<String> seriousOutcome = fdaQueryCondition.getSeriousOutcome();
        //性别
        List<String> sex = fdaQueryCondition.getSex();
        //是否展示
        String isShowUnknown = fdaQueryCondition.getIsShowUnknown();
        //上报职业
        List<String> career = fdaQueryCondition.getCareer();
        //检索时间

        ArrayList<String> summeryTatle = new ArrayList<>();
        summeryTatle.add("数据来源于 JADER数据库（https://www.pmda.go.jp）。JADER数据库以csv文件的形式储存，下载 JADER 数据库中有建库至"+ configUtil.getConfig(ConfigEnum.FEARS_END_DATE_JD2)+"上报所有的 ADE 报告数据。\n" +
                "包括 4个表格，其中人口统计信息（DEMO）表记录了患者的基本情况、报告人等信息；药物信息（DRUG）表记录了药品名称、给药途径、给药剂量等信息；ADE信息（REAC）表记录了ADE和转归结局；原发疾病（HIST）表记录了患者的原发疾病等信息。所有表格的数据结构均含有报告识别号，通过该字段对各表格进行关联。");
        //检索时间
        summeryTatle.add("以"+drugName+"作为关键词在JADER数据库中进行检索，分析药物参与度为“可疑”的报告。\n" +
                "JADER 数据库采用《国际医学用语词典》（MedDRA）中的首选术语（PT）编码不良事件。根据 MedDRA 对各不良事件进行中日文映射，并整理对应的主系统器官分类（SOC）。");
        //匹配信息
        StringBuilder stringBuilder = new StringBuilder();
        stringBuilder.append("在“drug name”或“prod_ai”进行");
        stringBuilder.append("1".equals(userSynonm.getString("isVague")) ? "模糊" : "精准");
        stringBuilder.append("匹配，限定“");
        stringBuilder.append(drugName);
        stringBuilder.append("”，“role_cod”为");
        for (String s : getRole(role)) {
            stringBuilder.append(s);
            stringBuilder.append("、");
        }
        stringBuilder.delete(stringBuilder.length() - 1, stringBuilder.length());
        stringBuilder.append("；从中筛选出相关ADE报告。");
        summeryTatle.add(stringBuilder.toString());
        summeryTatle.add("您选择的其他筛选条件为 ：");
        summeryTatle.add("未知数据：" + ("0".equals(isShowUnknown) ? "不展示" : "展示"));
        if (userSynonm.getIntValue("type") == 1 || userSynonm.getIntValue("type") == 3) {
            summeryTatle.add("不良反应: " + pt);
        }
        if (Objects.nonNull(indication) &&!indication.contains("不限")) {
            StringBuilder stringBuilder1 = new StringBuilder();
            stringBuilder1.append("适应症：");
            for (String s : indication) {
                JSONObject ptAllData = mongoTemplate.findOne(new Query(Criteria.where("pt_en").is(s)), JSONObject.class, "pt_all_data");
                String ptCh = "";
                if (ptAllData != null) {
                    ptCh = ptAllData.getString("pt_ch");
                } else if ("unknown".equals(s)) {
                    ptCh = "未知";
                } else {
                    String trans = DeeplApi.trans(s);
                    ptCh = trans;
                    JSONObject jsonObject1 = new JSONObject();
                    jsonObject1.put("pt_en", s);
                    jsonObject1.put("pt_ch", ptCh);
                    mongoTemplate.save(jsonObject1, "pt_jd_data");
                }
                stringBuilder1.append(ptCh + "（" + s + "）");
                stringBuilder1.append("、");
            }

            stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
            summeryTatle.add(stringBuilder1.toString());

        }

        if (Objects.nonNull(seriousOutcome)&&!seriousOutcome.contains("不限")) {
            StringBuilder stringBuilder1 = new StringBuilder();
            stringBuilder1.append("严重不良反应结局：");
            for (String s : seriousOutcome) {
                stringBuilder1.append(DownloadServiceImpl.MY_OUTCOME_MAP.get(s));
                stringBuilder1.append("、");
            }
            stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
            summeryTatle.add(stringBuilder1.toString());

        }
        if (Objects.nonNull(age)&&!age.contains("不限")) {
            StringBuilder stringBuilder1 = new StringBuilder();
            stringBuilder1.append("年龄：");
            for (String s : age) {
                if ("成人".equals(s)) {
                    stringBuilder1.append("成人（18-64岁）");
                } else if ("儿童".equals(s)) {
                    stringBuilder1.append("儿童（≤18岁）");
                } else if ("老年人".equals(s)) {
                    stringBuilder1.append("老年人（≥65岁）");
                }
                stringBuilder1.append("、");
            }
            stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
            summeryTatle.add(stringBuilder1.toString());

        }

        if ( Objects.nonNull(sex)&&!sex.contains("不限")) {
            StringBuilder stringBuilder1 = new StringBuilder();
            stringBuilder1.append("性别：");
            for (String s : sex) {
                stringBuilder1.append(s);
                stringBuilder1.append("、");
            }
            stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
            summeryTatle.add(stringBuilder1.toString());
        }

        if ( Objects.nonNull(career)&& !career.contains("不限")) {
            StringBuilder stringBuilder1 = new StringBuilder();
            stringBuilder1.append("职业：");
            for (String s : career) {
                stringBuilder1.append(DownloadServiceImpl.MY_CAREER_MAP.get(s));
                stringBuilder1.append("、");
            }
            stringBuilder1.delete(stringBuilder1.length() - 1, stringBuilder1.length());
            summeryTatle.add(stringBuilder1.toString());

        }

        summeryTatle.add("方法学内容详见附录。");
        ans.getJSONObject("result").put("baseInfo", new JSONObject());
        ans.getJSONObject("result").getJSONObject("baseInfo").put("table1", new JSONObject());
        ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").put("title", "表3 ADE报告的基本情况");
        ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").put("titleEn", "Table 3. Basic information of ADE reports");
        ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").put("data", new JSONArray());

        JSONArray sex_list = queryData.getJSONArray("sex_m_f");
        Map<String, String> renderData = new HashMap<>();

        //男性女性
        String sex_m = "";
        String sex_mx = "";

        String sex_f = "";
        String sex_fx = "";

        if (CollUtil.isNotEmpty(sex_list)) {

            JSONObject sexHead = new JSONObject();
            sexHead.put("tag", "性别");
            sexHead.put("info", "");
            sexHead.put("case", "");
            sexHead.put("rate", "");

            ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(sexHead);

            List<List<String>> sex_ll = new ArrayList<>();
            for (JSONArray jsonArray : sex_list.toJavaList(JSONArray.class)) {
                sex_ll.add(jsonArray.toJavaList(String.class));
            }
            sex_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            for (List<String> l : sex_ll) {
                JSONObject sextable = new JSONObject();
                sextable.put("info", l.get(1));
                sextable.put("case", l.get(2));
                sextable.put("rate", l.get(3));
                if ("男".equals(l.get(1))) {
                    sex_m = l.get(2);
                    sex_mx = l.get(3);
                } else if ("女".equals(l.get(1))) {
                    sex_f = l.get(2);
                    sex_fx = l.get(3);
                }
                ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(sextable);
            }
            try {
                renderData.put("sex1", sex_ll.get(1).get(1));
                renderData.put("sex1Rate", sex_ll.get(1).get(3));
                renderData.put("sex2", sex_ll.get(0).get(1));
                renderData.put("sex2Rate", sex_ll.get(0).get(3));
            } catch (Exception e) {
                e.printStackTrace();
            }

        }


        //体重
        String wt_na = "";
        String wt_ca = "";

        JSONArray weight_list = queryData.getJSONArray("wt_list");
        if (CollectionUtil.isNotEmpty(weight_list)) {
            JSONObject sexHead = new JSONObject();
            sexHead.put("tag", "体质量 / kg");
            sexHead.put("info", "");
            sexHead.put("case", "");
            sexHead.put("rate", "");

            ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(sexHead);

            List<List<String>> sex_ll = new ArrayList<>();
            for (JSONArray jsonArray : weight_list.toJavaList(JSONArray.class)) {
                sex_ll.add(jsonArray.toJavaList(String.class));
            }
            sex_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            for (List<String> l : sex_ll) {
                JSONObject sextable = new JSONObject();
                sextable.put("info", l.get(1));
                sextable.put("case", l.get(2));
                sextable.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(sextable);
            }
            try {
                renderData.put("wt1", sex_ll.get(0).get(1));
                wt_ca = sex_ll.get(0).get(1);
                renderData.put("wt1Rate", sex_ll.get(0).get(3));
                wt_na = sex_ll.get(0).get(3);
                renderData.put("wt2", sex_ll.get(1).get(1));
                renderData.put("wt2Rate", sex_ll.get(1).get(3));
            } catch (Exception e) {
                e.printStackTrace();
            }
        }


        JSONArray age_list = queryData.getJSONArray("age_list");
        String age_na = "";
        String age_ca = "";
        String age_fx = "";

        if (CollectionUtil.isNotEmpty(age_list)) {
            JSONObject ageHead = new JSONObject();
            ageHead.put("tag", "年龄（岁）");
            ageHead.put("info", "");
            ageHead.put("case", "");
            ageHead.put("rate", "");

            ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(ageHead);
            List<List<String>> age_ll = new ArrayList<>();
            for (JSONArray jsonArray : age_list.toJavaList(JSONArray.class)) {
                age_ll.add(jsonArray.toJavaList(String.class));
            }

            String[] order = {"≤18岁", "18＜年龄＜65", "≥65岁", "未知"};
            //比较器的map
            Map<String, Integer> orderMap = new HashMap<>();
            for (int i = 0; i < order.length; i++) {
                orderMap.put(order[i], i);
            }
            // 自定义比较器
            Comparator<List<String>> customComparator = (list1, list2) -> {
                String key1 = (String) list1.get(2);
                String key2 = (String) list2.get(2);
                return Integer.compare(orderMap.getOrDefault(key1, order.length), orderMap.getOrDefault(key2, order.length));
            };


            List<List<String>> sortedAgeList = age_ll.stream()
                    .sorted(customComparator)
                    .collect(Collectors.toList());
            if ("未知".equals(sortedAgeList.get(0).get(1))) {
                age_na = sortedAgeList.get(1).get(1);
                age_ca = sortedAgeList.get(1).get(2);
                age_fx = sortedAgeList.get(1).get(3);
            } else {
                age_na = sortedAgeList.get(0).get(1);
                age_ca = sortedAgeList.get(0).get(2);
                age_fx = sortedAgeList.get(0).get(3);
            }

            for (List<String> l : sortedAgeList) {
                JSONObject agex = new JSONObject();
                agex.put("info", l.get(1));
                agex.put("case", l.get(2));
                agex.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(agex);
            }
            renderData.put("age1", age_ll.get(0).get(1));
            renderData.put("age1Rate", age_ll.get(0).get(3));
        }

        //体重
        JSONArray reportType = queryData.getJSONArray("reportType");
        if (CollectionUtil.isNotEmpty(reportType)) {
            JSONObject sexHead = new JSONObject();
            sexHead.put("tag", "报告类型");
            sexHead.put("info", "");
            sexHead.put("case", "");
            sexHead.put("rate", "");

            ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(sexHead);

            List<List<String>> sex_ll = new ArrayList<>();
            for (JSONArray jsonArray : reportType.toJavaList(JSONArray.class)) {
                sex_ll.add(jsonArray.toJavaList(String.class));
            }
            sex_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            for (List<String> l : sex_ll) {
                JSONObject sextable = new JSONObject();
                sextable.put("info", l.get(1));
                sextable.put("case", l.get(2));
                sextable.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(sextable);
            }
            try {
                renderData.put("type1", sex_ll.get(0).get(1));
                renderData.put("type1Rate", sex_ll.get(0).get(3));
                renderData.put("type2", sex_ll.get(1).get(1));
                renderData.put("type2Rate", sex_ll.get(1).get(3));
            } catch (Exception e) {
                e.printStackTrace();
            }
        }


        String occp_na = "";
        String occp_ca = "";
        String occp_fx = "";

        JSONArray occp_list = queryData.getJSONArray("occp_cod");
        if (occp_list != null) {
            JSONObject occpHead = new JSONObject();
            occpHead.put("tag", "上报者职业");
            occpHead.put("info", "");
            occpHead.put("case", "");
            occpHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(occpHead);

            List<List<String>> occp_ll = new ArrayList<>();
            for (JSONArray jsonArray : occp_list.toJavaList(JSONArray.class)) {
                occp_ll.add(jsonArray.toJavaList(String.class));
            }
            try {
            occp_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            occp_na = occp_ll.get(0).get(1);
            occp_ca = occp_ll.get(0).get(2);
            occp_fx = occp_ll.get(0).get(3);

            for (List<String> l : occp_ll) {
                JSONObject occp = new JSONObject();
                occp.put("info", l.get(1));
                occp.put("case", l.get(2));
                occp.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(occp);
            }
            } catch (IndexOutOfBoundsException e) {
                log.error("occp_ll.get(0).get(1) is null");
            }
            try {
                renderData.put("occp1", occp_ll.get(0).get(1));
                renderData.put("occp1Rate", occp_ll.get(0).get(3));
            } catch (IndexOutOfBoundsException e) {
                log.error("occp_ll.get(0).get(1) is null");
            }

        }

        String year_na = "";
        String year_ca = "";
        String year_fx = "";
        JSONArray year_ll = queryData.getJSONArray("year_list");
        if (year_ll != null) {
            JSONObject occpHead = new JSONObject();
            occpHead.put("tag", "上报年份");
            occpHead.put("info", "");
            occpHead.put("case", "");
            occpHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(occpHead);

            try {
            List<List<String>> occp_ll = new ArrayList<>();
            for (JSONArray jsonArray : year_ll.toJavaList(JSONArray.class)) {
                occp_ll.add(jsonArray.toJavaList(String.class));
            }
            occp_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            year_na = occp_ll.get(0).get(1);
            year_ca = occp_ll.get(0).get(2);
            year_fx = occp_ll.get(0).get(3);
            occp_ll.sort((a, b) -> Integer.parseInt(b.get(1)) - Integer.parseInt(a.get(1)));
            for (List<String> l : occp_ll) {
                JSONObject occp = new JSONObject();
                occp.put("info", l.get(1));
                occp.put("case", l.get(2));
                occp.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("baseInfo").getJSONObject("table1").getJSONArray("data").add(occp);
            }
        } catch (IndexOutOfBoundsException e) {
            log.error("occp_ll.get(0).get(1) is null");
        }


        }

        String baseSummaryTemplate = "JADER数据库自2004年4月-2024年6月 共检索到报告" + string1 + "份，其中以" + drugName + "为“可疑”药物的报告共" + totalCase + "份。性别构成上，女性" + sex_f + "例（" + sex_fx + "），男性" + sex_m + "例（" + sex_mx + "），患者年龄主要集中在" + age_na + " ，有" + age_ca + "例（" + age_fx + "）。上报人员以" + occp_na + "为主，占" + occp_fx + "。以" + year_na + " 年上报数量最多，有" + year_ca + "例（" + year_fx + "）。";
//        ans.getJSONObject("result").getJSONObject("baseInfo").put("summary", render(baseSummaryTemplate, renderData));
        ans.getJSONObject("result").getJSONObject("baseInfo").put("summary", baseSummaryTemplate);
        ans.getJSONObject("result").put("drugInfo", new JSONObject());
        ans.getJSONObject("result").getJSONObject("drugInfo").put("table2", new JSONObject());
        ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").put("title", "表4 ADE的给药情况、处置和转归");
        ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").put("data", new JSONArray());

        String indi_str = "";
        String indi_ca = "";
        String indi_fx = "";

        try {

        JSONArray indi_pt_list = queryData.getJSONArray("indi_pt_list");
        if (CollectionUtil.isNotEmpty(indi_pt_list)) {
            JSONObject occpHead = new JSONObject();
            occpHead.put("tag", "给药原因");
            occpHead.put("info", "");
            occpHead.put("case", "");
            occpHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getJSONArray("data").add(occpHead);

            List<List<String>> indi_pt_ll = new ArrayList<>();
            for (JSONArray jsonArray : indi_pt_list.toJavaList(JSONArray.class)) {
                indi_pt_ll.add(jsonArray.toJavaList(String.class));
            }
            indi_pt_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            StringBuilder indi = new StringBuilder();
            indi_str = indi_pt_ll.get(0).get(1) + "(" + indi_pt_ll.get(0).get(1) + ")";
            indi_ca = indi_pt_ll.get(0).get(2);
            indi_fx = indi_pt_ll.get(0).get(3);
            int indiCursor = 0;
            for (List<String> l : indi_pt_ll) {
                JSONObject dur = new JSONObject();
                List<JSONObject> jsonObjects = mongoTemplate.find(Query.query(Criteria.where("pt_en").is(l.get(1))), JSONObject.class, "pt_jd_data");
                if (CollUtil.isNotEmpty(jsonObjects)) {
                    l.set(4,jsonObjects.get(0).getString("pt_ch"));
                }
                dur.put("info", l.get(4) + "(" + l.get(1) + ")");
                dur.put("case", l.get(2));
                dur.put("rate", l.get(3));
                if (indiCursor >= 5) {
                    break;
                }
                if (!l.get(4).startsWith("未知")) {
                    indi.append(l.get(4)).append(",");
                }
                indiCursor++;
                ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getJSONArray("data").add(dur);
            }
        }
        } catch (IndexOutOfBoundsException e) {
            log.error("occp_ll.get(0).get(1) is null");
        }

        String dose_amt_str = "";
        String dose_amt_str1 = "";
        String dose_amt_ca = "";
        String dose_amt_ca1 = "";
        String dose_amt_fx = "";
        String dose_amt_fx1 = "";
        try {


        JSONArray dose_amt_list = queryData.getJSONArray("dose_amt_list");
        if (CollUtil.isNotEmpty(dose_amt_list)) {
            JSONObject doseAmtHead = new JSONObject();
            doseAmtHead.put("tag", "给药剂量");
            doseAmtHead.put("info", "");
            doseAmtHead.put("case", "");
            doseAmtHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getJSONArray("data").add(doseAmtHead);

            List<List<String>> dose_amt_ll = new ArrayList<>();
            for (JSONArray jsonArray : dose_amt_list.toJavaList(JSONArray.class)) {
                dose_amt_ll.add(jsonArray.toJavaList(String.class));
            }
            dose_amt_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            int cnt = 0;
            dose_amt_str = dose_amt_ll.get(0).get(1);
            dose_amt_str1 = dose_amt_ll.get(1).get(1);
            dose_amt_ca = dose_amt_ll.get(0).get(2);
            dose_amt_ca1 = dose_amt_ll.get(1).get(2);
            dose_amt_fx = dose_amt_ll.get(0).get(3);
            dose_amt_fx1 = dose_amt_ll.get(1).get(3);
            for (List<String> l : dose_amt_ll) {
                JSONObject amt = new JSONObject();
                amt.put("info", l.get(1));
                amt.put("case", l.get(2));
                amt.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getJSONArray("data").add(amt);
                if ((cnt++) >= 4) {
                    break;
                }
            }
            if (dose_amt_ll.get(0).get(1).toLowerCase().startsWith("unknow") && dose_amt_ll.size() >= 2) {
                renderData.put("doseamt2", dose_amt_ll.get(1).get(1));
            } else {
                try {
                    renderData.put("route2", dose_amt_ll.get(0).get(3));
                } catch (Exception e) {
                    e.printStackTrace();
                }

            }
        }
        } catch (IndexOutOfBoundsException e) {
            log.error("occp_ll.get(0).get(1) is null");
        }
        String route_str = "";
        String route_ca = "";
        String route_fx = "";

        try {
        JSONArray route_list = queryData.getJSONArray("route_list");
        if (CollUtil.isNotEmpty(route_list)) {
            List<List<String>> route_ll = new ArrayList<>();
            for (JSONArray jsonArray : route_list.toJavaList(JSONArray.class)) {
                route_ll.add(jsonArray.toJavaList(String.class));
            }
            JSONObject routeHead = new JSONObject();
            routeHead.put("tag", "给药途径/例");
            routeHead.put("info", "");
            routeHead.put("case", "");
            routeHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getJSONArray("data").add(routeHead);
            route_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));

            route_str =  route_ll.get(0).get(1);
            route_ca = route_ll.get(0).get(2);
            route_fx = route_ll.get(0).get(3);
            if (route_ll.get(0).get(1).toLowerCase().startsWith("unknow") && route_ll.size() >= 2) {
                renderData.put("route2", route_ll.get(1).get(4));
            } else {
                renderData.put("route2", route_ll.get(0).get(4));
            }
            int cnt = 0;
            for (List<String> l : route_ll) {
                JSONObject route = new JSONObject();
                route.put("info", l.get(1) );
                route.put("case", l.get(2));
                route.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getJSONArray("data").add(route);
                if ((cnt++) >= 4) {
                    break;
                }
            }
        }
        } catch (IndexOutOfBoundsException e) {
            log.error("occp_ll.get(0).get(1) is null");
        }



        String of_str = "";
        String of_ca = "";
        String of_fx = "";

        try {
            JSONArray disposeOf = queryData.getJSONArray("disposeOf");
            if (CollUtil.isNotEmpty(disposeOf)) {
                List<List<String>> route_ll = new ArrayList<>();
                for (JSONArray jsonArray : disposeOf.toJavaList(JSONArray.class)) {
                    route_ll.add(jsonArray.toJavaList(String.class));
                }
                JSONObject routeHead = new JSONObject();
                routeHead.put("tag", "处置方式/例");
                routeHead.put("info", "");
                routeHead.put("case", "");
                routeHead.put("rate", "");
                ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getJSONArray("data").add(routeHead);
                route_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));

                of_str =  route_ll.get(0).get(1);
                of_ca = route_ll.get(0).get(2);
                of_fx = route_ll.get(0).get(3);

                int cnt = 0;
                for (List<String> l : route_ll) {
                    JSONObject route = new JSONObject();
                    route.put("info", l.get(1) );
                    route.put("case", l.get(2));
                    route.put("rate", l.get(3));
                    ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getJSONArray("data").add(route);
                    if ((cnt++) >= 4) {
                        break;
                    }
                }
            }
        } catch (IndexOutOfBoundsException e) {
            log.error("occp_ll.get(0).get(1) is null");
        }

        String dose_freq_str = "";
        String dose_freq_str1 = "";
        String dose_freq_ca = "";
        String dose_freq_ca1 = "";
        String dose_freq_fx = "";
        String dose_freq_fx1 = "";
        try {

        //处置方式
        JSONArray outc_code_list = queryData.getJSONArray("outc_cod_list");
        if (outc_code_list != null) {
            JSONObject outHead = new JSONObject();
            outHead.put("tag", "转归情况");
            outHead.put("info", "");
            outHead.put("case", "");
            outHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getJSONArray("data").add(outHead);
            List<List<String>> outc_code_ll = new ArrayList<>();
            for (JSONArray jsonArray : outc_code_list.toJavaList(JSONArray.class)) {
                outc_code_ll.add(jsonArray.toJavaList(String.class));
            }

            outc_code_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));

            dose_freq_str = outc_code_ll.get(0).get(1);
            if(outc_code_ll.size()>1){
                dose_freq_str1 = outc_code_ll.get(1).get(1);
                dose_freq_ca1 = outc_code_ll.get(1).get(2);
                dose_freq_fx1 = outc_code_ll.get(1).get(3);
            }

            dose_freq_ca = outc_code_ll.get(0).get(2);

            dose_freq_fx = outc_code_ll.get(0).get(3);

            for (List<String> l : outc_code_ll) {
                JSONObject out = new JSONObject();
                out.put("info", l.get(1));
                out.put("case", l.get(2));
                out.put("rate", l.get(3));
                ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table2").getJSONArray("data").add(out);
            }

            renderData.put("seriours1", outc_code_ll.get(0).get(1));
            renderData.put("seriours1Rate", outc_code_ll.get(0).get(3));
        }
        } catch (IndexOutOfBoundsException e) {
            log.error("occp_ll.get(0).get(1) is null");
        }

        //      String baseSummaryTemplate = "在已知的数据中：性别构成上，#{sex1}性（#{sex1Rate}）少于#{sex2}性（#{sex2Rate}）；，年龄主要集中在#{age1}（#{age1Rate}）；，上报者主要为#{occp1}。；转归以#{seriours1}报告数最多（#{seriours1Rate}）。其人口学特征及严重不良事件构成情况见表 1。不良反应逐年上报情况详见表 2。";
        String baseSummaryTemplate1 = "上报的 " + titleCountx.get(1) + " 例 ADE中，多数用药目的是" + indi_str + "，共 " + indi_ca + "例，占 " + indi_fx + "。单次给药剂量以" + dose_amt_str + "为主，占" + dose_amt_fx + "；其次是" + dose_amt_str1 + " ，占 " + dose_amt_fx1 + "。给药途径以" + route_str + "为主，占 " + route_fx + " 。主要的转归为" + dose_freq_str + (StringUtils.isEmpty(dose_freq_str1) ? "" :"和" + dose_freq_str1 )+ " ，分别占" + dose_freq_fx +(StringUtils.isEmpty(dose_freq_fx1)?"":"和" + dose_freq_fx1) + "。见表 4。";
        ans.getJSONObject("result").getJSONObject("drugInfo").put("summary", baseSummaryTemplate1);


//        ans.getJSONObject("result").put("drugInfo", new JSONObject());
//        ans.getJSONObject("result").getJSONObject("drugInfo").put("table3", new JSONObject());
//        ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").put("title", "表3  用药情况");
//        ans.getJSONObject("result").getJSONObject("drugInfo").getJSONObject("table3").put("data", new JSONArray());
//

        //indication 写错了携程condition了 结构层次也错了
        ans.getJSONObject("result").put("condition", new JSONObject());
        ans.getJSONObject("result").getJSONObject("condition").put("table4", new JSONObject());
        ans.getJSONObject("result").getJSONObject("condition").getJSONObject("table4").put("data", new JSONArray());
        ans.getJSONObject("result").getJSONObject("condition").getJSONObject("table4").put("title", "表5 排名前10的ADE症状分布");


        ans.getJSONObject("result").put("doseRegimenOnsetDistribution", new JSONObject());
        ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").put("table5", new JSONObject());
        ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").put("title", "表6 排名前10的ADE信号分布");
        ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").put("data", new JSONArray());


        JSONArray drug_num_list = queryData.getJSONArray("drug_num_list");
        if (CollectionUtil.isNotEmpty(drug_num_list)) {
            JSONObject drugNumHead = new JSONObject();
            drugNumHead.put("tag", "给药方案");
            drugNumHead.put("affect", "");
            drugNumHead.put("case", "");
            drugNumHead.put("rate", "");
            ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").getJSONArray("data").add(drugNumHead);
            if (drug_num_list != null) {
                for (JSONArray jsonArray : drug_num_list.toJavaList(JSONArray.class)) {

                    if ("联合用药".equals(jsonArray.getString(1))) {
                        renderData.put("联用药比例", jsonArray.getString(3));
                        String substring = jsonArray.getString(3).substring(0, 2);
                        try {
                            if (Integer.parseInt(substring) >= 50) {
                                renderData.put("giveDrug", "联合用药");
                            } else {
                                renderData.put("giveDrug", "单药");
                            }
                        } catch (Exception e) {
                            renderData.put("giveDrug", "单药");
                        }

                    } else {
                        renderData.put("单药药比例", jsonArray.getString(3));
                    }

                    JSONObject drugNum = new JSONObject();
                    drugNum.put("affect", jsonArray.getString(1));
                    drugNum.put("case", jsonArray.getString(2));
                    drugNum.put("rate", jsonArray.getString(3));
                    ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").getJSONArray("data").add(drugNum);
                }
            }
        }


        JSONObject cutHead = new JSONObject();
        cutHead.put("tag", "不良反应发生时间");
        cutHead.put("affect", "");
        cutHead.put("case", "");
        cutHead.put("rate", "");
        ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").getJSONArray("data").add(cutHead);


        JSONArray cut_dt_list = queryData.getJSONArray("cut_dt_list");
        if (CollectionUtil.isNotEmpty(cut_dt_list)) {
            List<List<String>> cut_dt_ll = new ArrayList<>();
            int count = 0;
            for (JSONArray jsonArray : cut_dt_list.toJavaList(JSONArray.class)) {
                cut_dt_ll.add(jsonArray.toJavaList(String.class));
                JSONObject cut = new JSONObject();
                cut.put("affect", jsonArray.getString(1));
                cut.put("case", jsonArray.getString(2));
                cut.put("rate", jsonArray.getString(3));
                ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").getJSONObject("table5").getJSONArray("data").add(cut);
                if (count >= 4) {
                    break;
                }
                count++;
            }
            cut_dt_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            if (cut_dt_ll.get(0).get(1).toLowerCase().startsWith("unknow") && cut_dt_ll.size() >= 2) {
                renderData.put("cutdt3", cut_dt_ll.get(1).get(1));
            } else {
                renderData.put("cutdt3", cut_dt_ll.get(0).get(1));
            }
        }
        // ans.getJSONObject("result").put("doseRegimenOnsetDistribution", new JSONObject());
        ans.getJSONObject("result").getJSONObject("doseRegimenOnsetDistribution").put("summary", render("给药方案中以#{giveDrug}居多，；不良反应多发生在用药后#{cutdt3}。详见表 5。", renderData));


        ans.put("adverseSignals", new JSONObject());
        ans.getJSONObject("adverseSignals").put("adrsResult", new JSONObject());

        ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").put("table3", new JSONObject());
        ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table3").put("title", "表5 排名前10的ADE症状分布");
        ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table3").put("data", new JSONArray());

        JSONArray pt_lsit = queryData.getJSONArray("pt_list");
        if (CollectionUtil.isNotEmpty(pt_lsit)) {
            List<List<String>> pt_ll = new ArrayList<>();
            for (JSONArray l : pt_lsit.toJavaList(JSONArray.class)) {
                pt_ll.add(l.toJavaList(String.class));
            }
            pt_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
            for (int i = 0; i < pt_ll.size() && i < 10; i++) {
                JSONObject data = new JSONObject();
                data.put("rank", i + 1);
                data.put("pt", pt_ll.get(i).get(1));
                data.put("badEvent", pt_ll.get(i).get(4));
                data.put("case", pt_ll.get(i).get(2));
                data.put("rate", pt_ll.get(i).get(3));
                ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table3").getJSONArray("data").add(data);
            }
            StringBuilder adrs10 = new StringBuilder();

            for (JSONObject adrs : ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table3").getJSONArray("data").toJavaList(JSONObject.class)) {
                adrs10.append(adrs.getString("badEvent")).append(",");
            }

        }
        try {
            JSONArray jsonArray = ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").getJSONObject("table3").getJSONArray("data");
            ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").put("summary", "在JADER数据库中， " + totalCase + "  例报告中发生频率较高的主要有" + jsonArray.getJSONObject(0).getString("badEvent") + "、" +
                    jsonArray.getJSONObject(1).getString("badEvent") + "、" + jsonArray.getJSONObject(2).getString("badEvent") + "、" + jsonArray.getJSONObject(3).getString("badEvent") + "、" + jsonArray.getJSONObject(4).getString("badEvent") + " 等。");
            ans.getJSONObject("adverseSignals").put("typicalSignalResult", new JSONObject());
            ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").put("table4", new JSONObject());
            ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table4").put("title", "表6 排名前10的ADE信号分布");
            ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table4").put("data", new JSONArray());
        }catch (Exception e){
            ans.getJSONObject("adverseSignals").getJSONObject("adrsResult").put("summary", "");
            ans.getJSONObject("adverseSignals").put("typicalSignalResult", new JSONObject());
            ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").put("table4", new JSONObject());
            ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table4").put("title", "表6 排名前10的ADE信号分布");
            ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table4").put("data", new JSONArray());
        }
        try {
            String title = "";
            JSONObject signaldict = queryData.getJSONObject("signal_dict").getJSONObject("data");

            if (CollectionUtil.isNotEmpty(signaldict)) {
                List<List<String>> signaldictll = new ArrayList<>();
                for (Map.Entry<String, Object> entry : signaldict.entrySet()) {
                    List<List<String>> l = (List<List<String>>) entry.getValue();
                    for (List<String> ll : l) {
                        ll.set(1, String.valueOf(ll.get(1)));
                        if (Integer.parseInt(ll.get(1)) >= 3) {
                            signaldictll.add(ll);
                        }

                    }
                }
                try {
                    signaldictll.sort((o1, o2) -> {
                        double ror1 = Double.parseDouble(o1.get(3));
                        double ror2 = Double.parseDouble(o2.get(3));
                        return Double.compare(ror2, ror1);
                    });
                } catch (Exception e) {
                    e.printStackTrace();
                }
                for (int i = 0; i < signaldictll.size() && i < 10; i++) {
                    List<String> l = signaldictll.get(i);
                    JSONObject signal = new JSONObject();
                    for (Map.Entry<String, Object> entry : signaldict.entrySet()) {
                        List<List<String>> ll = (List<List<String>>) entry.getValue();
                        for (List<String> lll : ll) {
                            if (lll.contains(l.get(6))) {
                                signal.put("soc", entry.getKey() + "/" + l.get(0));
                                break;
                            }
                        }
                    }
                    signal.put("rank", i + 1);
                    signal.put("pt", l.get(0));
                    signal.put("badEvent", l.get(6));
                    signal.put("case", l.get(1));
                    signal.put("rate", l.get(2));
                    signal.put("ror", new BigDecimal(l.get(3)).setScale(2, BigDecimal.ROUND_HALF_UP)+"("+l.get(7)+","+l.get(8)+")");
                    signal.put("ebgm", new BigDecimal(l.get(4)).setScale(2, BigDecimal.ROUND_HALF_UP));
                    signal.put("ic", new BigDecimal(l.get(5)).setScale(2, BigDecimal.ROUND_HALF_UP)+"("+l.get(9)+","+l.get(10)+")");
                    signal.put("rorPro", "("+l.get(7)+","+l.get(8)+")");
                    signal.put("icPro", "("+l.get(10)+","+l.get(9)+")");
                    title = title + l.get(6) + "、";
                    ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table4").getJSONArray("data").add(signal);
                }
                title = title.substring(0, title.length() - 1);
                ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").put("summary", "通过ROR法等对相关ADE信号进行挖掘与筛选，将筛选出的 PT。" + titleCountx.get(2) + "例报告中信号主要有" + title + "等");

            }
        } catch (Exception e) {
            e.printStackTrace();
        }
        String string = userSynonm.getString("prop1");

        if(StringUtils.isNotEmpty(getDrugEngPt(userSynonm))){
            string = getDrugEngPt(userSynonm) +"不属于"+drugName+"的典型信号。";
            ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table4").put("data", new JSONArray());
        }

        try {


            ans.getJSONObject("adverseSignals").getJSONObject("typicalSignalResult").getJSONObject("table4").put("summary", string);
            ans.getJSONObject("adverseSignals").put("drugADEsTimeChart", new JSONObject());
            ans.getJSONObject("adverseSignals").getJSONObject("drugADEsTimeChart").put("summary", "根据信号检测结果，获得 IC 值居前 3 位的信号，即lactic acidosis（ROR=227.12，IC=6.93) 、hyperlactacidaemia（ROR=96.56，IC=6.02) 、base excess decreased（ROR=284.91，IC=5.96) 。为了考察这3个信号随着时间推移的变化趋势，绘制了近3年lactic acidosis、hyperlactacidaemia、base excess decreased安全信号的时间扫描图谱，结果见图1~3。");
            ans.getJSONObject("adverseSignals").getJSONObject("drugADEsTimeChart").put("images", new JSONArray());
        }catch (Exception e){
            e.printStackTrace();
        }
//        for (int i = 0; i < 3; i++) {
//            JSONObject data = new JSONObject();
//            data.put("title", "图1 2020-2022年metformin致lactic acidosis的安全信号的时间扫描图");
//            data.put("base64", "xxxxxxx");
//            ans.getJSONObject("adverseSignals").getJSONObject("drugADEsTimeChart").getJSONArray("images").add(data);
//        }
        StringBuilder regex = new StringBuilder();
        List<JSONObject> policys = new ArrayList<>();
        /*for (String drug : fdaQueryCondition.getDrug()) {
            regex.append(drug).append("|");
        }*/
        //修改政策查询逻辑
        StringBuilder inner = new StringBuilder();
        inner.append("(");
        List<String> drug = fdaQueryCondition1.getDrug();
        if (ObjectUtils.isEmpty(drug)) {
            String[] split = drugNameOut.split(";");
            for (String s : split) {
                drug.add(s);
            }
        }
        for (int i = 0; i < drug.size() - 1; i++) {
            String s = drug.get(i).replaceAll("\\(", "").replaceAll("\\)", "");
            inner.append(s).append("|");
        }
        String sOut = drug.get(drug.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
        inner.append(sOut);
        inner.append(")");
        regex.append("(?=.*").append(inner).append(")");

        ArrayList<String> strings = new ArrayList<>();
        JSONArray drugs = userSynonm.getJSONArray("drugs");
        for (JSONArray drugx : drugs.toJavaList(JSONArray.class)) {
            for (JSONObject x : drugx.toJavaList(JSONObject.class)) {
                strings.add(x.getString("word"));
                strings.add(x.getString("trans"));
            }
        }


//        if (CollUtil.isNotEmpty(strings)) {
//            // 创建查询对象
//            List<Criteria> orConditions = new ArrayList<>();
//
//            // 添加针对 synopsis 字段的或条件
//            for (String s : strings) {
//                orConditions.add(Criteria.where("synopsis").regex(Pattern.compile(s, Pattern.CASE_INSENSITIVE)));
//            }
//            Criteria criteria = new Criteria().orOperator(orConditions.toArray(new Criteria[0]));
//
//            Query query = new Query(criteria);
//            query.with(Sort.by(Sort.DEFAULT_DIRECTION.DESC, "data_time"));
//            List<JSONObject> pharmacovigilance = mongoTemplate.find(query, JSONObject.class, "pharmacovigilance");
//            List<Criteria> orConditions2 = new ArrayList<>();
//            for (String s : strings) {
//                orConditions2.add(Criteria.where("title").regex(Pattern.compile(s, Pattern.CASE_INSENSITIVE)));
//            }
//            Criteria criteria2 = new Criteria().orOperator(orConditions2.toArray(new Criteria[0]));
//            // 创建查询对象
//            Query query2 = new Query(criteria2);
//            query2.with(Sort.by(Sort.DEFAULT_DIRECTION.DESC, "data_time"));
//            List<JSONObject> pharmacovigilanceAdd = mongoTemplate.find(query2, JSONObject.class, "pharmacovigilance");
//            StringBuilder stringBuilder1 = new StringBuilder();
//            String stringsToRegex = strings.stream()
//                    .map(Pattern::quote) // 防止特殊字符影响正则表达式
//                    .collect(Collectors.joining("|")); // 使用 "|" 连接各个字符串
//            if (pharmacovigilance.size() > 0 || pharmacovigilanceAdd.size() > 0) {
//                int x = 0;
//                if (pharmacovigilance.size() > 0) {
//                    for (int i = 0; i < pharmacovigilance.size(); i++) {
//                        String content = "";
//                        JSONArray synopsis = pharmacovigilance.get(i).getJSONArray("synopsis");
//                        for (String s : synopsis.toJavaList(String.class)) {
//                            Pattern pattern = Pattern.compile(stringsToRegex, Pattern.CASE_INSENSITIVE);
//                            Matcher matcher = pattern.matcher(s);
//                            if (matcher.find()) {
//                                content = s;
//                            }
//                        }
//                        String circleNumber = String.valueOf((char) (0x2460 + x)); // 根据索引生成对应带圈数字的字符
//                        x++;
//                        JSONObject jsonObject1 = new JSONObject();
//                        JSONObject jsonObject2 = new JSONObject();
//                        jsonObject1.put("title", circleNumber + pharmacovigilance.get(i).getString("title") + "：" + content +
//                                "(发布时间：" + pharmacovigilance.get(i).getString("data_time") + ")");
//                        jsonObject2.put("title", "原文链接：" + pharmacovigilance.get(i).getString("title_url"));
//                        policys.add(jsonObject1);
//                        policys.add(jsonObject2);
//                    }
//                } else {
//                    for (int i = 0; i < pharmacovigilanceAdd.size(); i++) {
//                        String circleNumber = String.valueOf((char) (0x2460 + x)); // 根据索引生成对应带
//                        x++;
//                        JSONObject jsonObject1 = new JSONObject();
//                        jsonObject1.put("title", circleNumber + pharmacovigilanceAdd.get(i).getString("title") +
//                                "(发布时间：" + pharmacovigilanceAdd.get(i).getString("data_time") + ")");
//                        JSONObject jsonObject2 = new JSONObject();
//                        jsonObject2.put("title", "原文链接：" + pharmacovigilanceAdd.get(i).getString("title_url"));
//                        policys.add(jsonObject1);
//                        policys.add(jsonObject2);
//                    }
//                }
//                //policys.addAll(this.mongoTemplate.find(new Query(Criteria.where("conent").regex(regex.substring(0, regex.length() - 1), "i")), JSONObject.class, "yaojianju_yaowujingjie"));
//
//            }
//        }
//
//        ans.put("policyInfo", policys);
//        try {
//            //查询临床试验//
//            JSONObject cilinicalQuery = JSONObject.parseObject("{\"pageNum\":1,\"pageSize\":200,\"type\":0,\"change\":[1],\"registrationTimeSort\":2,\"endRegistrationTime\":\"\",\"startRegistrationTime\":\"\",\"maxSampleSize\":\"\",\"minSampleSize\":\"\",\"searchData\":\"#{drug}\",\"studyType\":[],\"testPhase\":[]}");
//            cilinicalQuery.put("searchData", userSynonm.getJSONArray("result").getJSONObject(0).getString("word"));
//            JSONObject cilinicalData = this.clinicalTrialFeign.getClinical(cilinicalQuery);
//            JSONArray cilinicals = cilinicalData.getJSONObject("data").getJSONArray("list");
//            ans.put("cilinical_trail", new JSONArray());
//            if (CollectionUtil.isNotEmpty(cilinicals)) {
//                for (JSONObject cilinical : cilinicals.toJavaList(JSONObject.class)) {
//                    String registerNo = cilinical.getString("registerNo");
//                    //判断是否存在不良反应
//                    JSONObject cilinicalAdrs = this.mongoTemplate.findOne(new Query(Criteria.where("register_no").is(registerNo)), JSONObject.class, "clinical_trial_registration_wxm");
//                    if (cilinicalAdrs != null) {
//                        cilinicalAdrs = JSON.parseObject(JSON.toJSONString(cilinicalAdrs, nameFilter));
//                        List<JSONObject> s = cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("SERIOUS_ADVERSE_EVENTS").toJavaList(JSONObject.class);
//                        if (s.size() > 1) {
//                            Map<String, List<JSONObject>> smap = new HashMap<>();
//                            for (JSONObject jsonObject : s) {
//                                String skey = "";
//                                if (jsonObject.containsKey("organ_system")) {
//                                    skey = jsonObject.getString("organ_system");
//                                }
//                                List<JSONObject> l = smap.getOrDefault(skey, new ArrayList<>());
//                                l.add(jsonObject);
//                                smap.put(skey, l);
//                            }
//                            s.clear();
//                            if (smap.get("") != null) {
//                                s.addAll(smap.get(""));
//                            }
//                            for (Map.Entry<String, List<JSONObject>> entry : smap.entrySet()) {
//                                if (entry.getKey().equals("")) {
//                                    continue;
//                                }
//                                JSONObject orga_sys = new JSONObject();
//                                orga_sys.put("tag", entry.getKey());
//                                orga_sys.put("organ_system", entry.getKey());
//                                orga_sys.put("stats", new ArrayList<>());
//
//                                orga_sys.put("assessment_type", "");
//                                orga_sys.put("source_vocabulary", "");
//                                s.add(orga_sys);
//                                s.addAll(entry.getValue());
//                            }
//                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("SERIOUS_ADVERSE_EVENTS").clear();
//                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("SERIOUS_ADVERSE_EVENTS").addAll(s);
//                        }
//
//                        List<JSONObject> ox = cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("OTHER_(NOT_INCLUDING_SERIOUS)_ADVERSE_EVENTS").toJavaList(JSONObject.class);
//                        if (ox.size() > 1) {
//                            Map<String, List<JSONObject>> omap = new HashMap<>();
//                            for (JSONObject jsonObject : ox) {
//                                String skey = "";
//                                if (jsonObject.containsKey("organ_system")) {
//                                    skey = jsonObject.getString("organ_system");
//                                }
//                                List<JSONObject> l = omap.getOrDefault(skey, new ArrayList<>());
//                                l.add(jsonObject);
//                                omap.put(skey, l);
//                            }
//                            ox.clear();
//                            if (omap.get("") != null) {
//                                ox.addAll(omap.get(""));
//                            }
//                            for (Map.Entry<String, List<JSONObject>> entry : omap.entrySet()) {
//                                if (entry.getKey().equals("")) {
//                                    continue;
//                                }
//                                JSONObject orga_sys = new JSONObject();
//                                orga_sys.put("tag", entry.getKey());
//                                orga_sys.put("organ_system", entry.getKey());
//                                orga_sys.put("stats", new ArrayList<>());
//
//                                orga_sys.put("assessment_type", "");
//                                orga_sys.put("source_vocabulary", "");
//                                ox.add(orga_sys);
//                                ox.addAll(entry.getValue());
//                            }
//                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("OTHER_(NOT_INCLUDING_SERIOUS)_ADVERSE_EVENTS").clear();
//                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("OTHER_(NOT_INCLUDING_SERIOUS)_ADVERSE_EVENTS").addAll(ox);
//                        }
//                        cilinicalAdrs.put("register_no", registerNo);
//                        cilinicalAdrs.put("public_title", cilinical.getString("publicTitle"));
//                        cilinicalAdrs.put("interventions", cilinical.getJSONArray("intervention"));
//                        //todo 处理这个
//                        cilinicalAdrs.put("lastUpdatePosted", cilinical.getString("registerDate"));
//                        ans.getJSONArray("cilinical_trail").add(cilinicalAdrs);
//                    }
//                }
//            }
//        } catch (Exception e) {
//            log.debug("临床试验无数据");
//        }
        ans.put("instruction", getInstructions(userSynonm));
        ans.put("references", Arrays.asList("[1]洪东升,倪剑,单文雅,李璐,胡希,羊红玉,赵青威,张幸国.基于监测数据的药物不良反应快速识别及R语言实现[J].浙江大学学报(医学版),2020,49(02):253-259."));
        ans.put("_id", id);
        this.mongoTemplate.remove(new Query(Criteria.where("_id").is(id)), "drug_safe_report_jd");
        this.mongoTemplate.insert(ans, "drug_safe_report_jd");
        return ans;
    }

//    public void assembleListData(JSONArray data, Document document) {
//        List<Map<String, Object>> maps = JSON.parseObject(JSON.toJSONString(data), new TypeReference<List<Map<String, Object>>>() {
//        });
//        if (CollUtil.isNotEmpty(maps)) {
//            for (Map<String, Object> map : maps) {
//                String result;
//                String tag = map.get("tag").toString();
//                if ("text".equals(tag)) {
//                    if (Objects.isNull(map.get("content"))){
//                        continue;
//                    }
//                    result = map.get("content").toString();
//                    result = wiffOfContent(result, "<br>", "");
//                    result = wiffOfContent(result, "</br>", "");
//                    try {
//                        setContentOne(wiffOfContent(result, "\n\n", "\n"), document);
//                    } catch (DocumentException e) {
//                        log.error(e.getMessage(), e);
//                    }
//                }
//                if ("img".equals(tag)) {
//                    if (Objects.isNull(map.get("content"))) {
//                        continue;
//                    }
//                    String base64String = map.get("content").toString();
//                    try {
//                        // 移除Base64数据前缀 "data:image/jpeg;base64," 或其他格式的前缀，如果你的字符串包含这些的话
//                        base64String = base64String.replaceAll("^(data:image/.*;base64,)", "");
//                        // Base64解码
//                        byte[] imageBytes = Base64.getDecoder().decode(base64String);
//                        Image image = Image.getInstance(imageBytes);
//                        //添加图片
//                        image.setAlignment(Element.ALIGN_CENTER);
//                        image.setBackgroundColor(Color.white);
//                        image.scaleToFit(500, 500);
//                        //                        image.setXYRatio(0.1f);
//                        document.add(image);
//                    } catch (Exception e) {
//                        System.err.println("转换图片时发生错误: " + e.getMessage());
//                    }
//                }
//            }
//        }
//    }


    private List<InstructionVo> getInstructions(JSONObject userSynonm) {
        List<JSONObject> ans = new ArrayList<>();
        JSONArray userWords = userSynonm.getJSONArray("drugs");
        ArrayList<InstructionVo> instructionVos = new ArrayList<>();
        int num = 1;
        for (JSONArray jsonArray1 : userWords.toJavaList(JSONArray.class)) {
            InstructionVo instructionVo = new InstructionVo();
            List<String> names = new ArrayList<>();
            for (JSONObject userWord : jsonArray1.toJavaList(JSONObject.class)) {
                if (StrUtil.isNotBlank(userWord.getString("word"))) {
                    names.add(userWord.getString("word").toLowerCase());

                }
                if (StrUtil.isNotBlank(userWord.getString("trans"))) {
                    names.add(userWord.getString("trans").toLowerCase());
                }
                if (CollectionUtil.isNotEmpty(userSynonm.getJSONArray("enSynonym"))) {
                    for (String str : userSynonm.getJSONArray("enSynonym").toJavaList(String.class)) {
                        names.add(str.toLowerCase());
                    }
                }
                if (CollectionUtil.isNotEmpty(userSynonm.getJSONArray("zhSynonym"))) {
                    for (String str : userSynonm.getJSONArray("zhSynonym").toJavaList(String.class)) {
                        names.add(str.toLowerCase());
                    }
                }
            }
            if (userWords.toJavaList(JSONArray.class).size() > 1){
                instructionVo.setDrugName("（"+num+"）"+names.get(0));
                num++;
            }


            Criteria orCriteria = new Criteria().orOperator(
                    Criteria.where("drugSynonymEn").in(names),
                    Criteria.where("drugEn").in(names),
                    Criteria.where("drugSynonymZh").in(names),
                    Criteria.where("drugZh").in(names),
                    Criteria.where("drugName").in(names)
            );
            Query query = new Query(orCriteria);
            List<JSONObject> drugInfo = this.mongoTemplate.find(query, JSONObject.class, "evaluation_drug_info_v2");
            HashSet<String> strings = new HashSet<>();
            strings.addAll(names);
            if (CollUtil.isNotEmpty(drugInfo)) {
                //收集检索词
                for (JSONObject jsonObject : drugInfo) {
                    strings.addAll(jsonObject.getJSONArray("drugSynonymEn").toJavaList(String.class));
                    strings.addAll(jsonObject.getJSONArray("drugSynonymZh").toJavaList(String.class));
                    strings.add(jsonObject.getString("drugEn"));
                    strings.add(jsonObject.getString("drugZh"));
                    strings.add(jsonObject.getString("drugName"));
                }
            }








            Criteria orCriteria1 = new Criteria().orOperator(
                    Criteria.where("commonName").in(strings),
                    Criteria.where("innName").in(strings),
                    Criteria.where("engName").in(strings)
            );
            Query query1 = new Query(orCriteria1);


            // //合理用药
            // List<JSONObject> jsonObjects = this.mongoTemplate.find(new Query(Criteria.where("drugName").in(strings)), JSONObject.class, "evaluation_medicine");
            // if (CollUtil.isNotEmpty(jsonObjects)) {
            //     for (JSONObject jsonObject : jsonObjects) {
            //         if (jsonObject.containsKey("warning") && CollUtil.isNotEmpty(jsonObject.getJSONArray("warning"))) {
            //             instructionVo.setWarnings(jsonObject.getJSONArray("warning").toJavaList(DrugContent.class));
            //         }
            //         if (jsonObject.containsKey("adverseReaction") && CollUtil.isNotEmpty(jsonObject.getJSONArray("adverseReaction"))) {
            //             instructionVo.setAdverseReactions(jsonObject.getJSONArray("adverseReaction").toJavaList(DrugContent.class));
            //         }
            //         if (jsonObject.containsKey("notes") && CollUtil.isNotEmpty(jsonObject.getJSONArray("notes"))) {
            //             instructionVo.setPrecautions(jsonObject.getJSONArray("notes").toJavaList(DrugContent.class));
            //         }
            //         if (jsonObject.containsKey("taboo") && CollUtil.isNotEmpty(jsonObject.getJSONArray("taboo"))) {
            //             instructionVo.setContraindications(jsonObject.getJSONArray("taboo").toJavaList(DrugContent.class));
            //         }
            //     }
            // }


            List<JSONObject> instructionxJson = this.mongoTemplate.find(query1, JSONObject.class, "evaluation_assistant_instructions_use");


            if (CollUtil.isNotEmpty(instructionxJson)) {
                //黑框警告
                JSONObject jsonWithMostNonEmptyFields = JsonUtil.mergeJsonsWithFirstNonEmptyFields(instructionxJson);
                JSONArray drugWarning = jsonWithMostNonEmptyFields.getJSONArray("drugWarning");
                if (CollectionUtil.isNotEmpty(drugWarning)) {
                    instructionVo.setWarnings(drugWarning.toJavaList(DrugContent.class));
                }
                JSONArray drugAdverseReactions = jsonWithMostNonEmptyFields.getJSONArray("adverseReactions");
                if (CollectionUtil.isNotEmpty(drugAdverseReactions) ) {
                    instructionVo.setAdverseReactions(drugAdverseReactions.toJavaList(DrugContent.class));
                }
                JSONArray drugPrecautions = jsonWithMostNonEmptyFields.getJSONArray("precautions");
                if (CollectionUtil.isNotEmpty(drugPrecautions) ) {
                    instructionVo.setPrecautions(drugPrecautions.toJavaList(DrugContent.class));
                }
                JSONArray drugContraindications = jsonWithMostNonEmptyFields.getJSONArray("contraindications");
                if (CollectionUtil.isNotEmpty(drugContraindications)) {
                    instructionVo.setContraindications(drugContraindications.toJavaList(DrugContent.class));
                }

            }

            instructionVos.add(instructionVo);
        }
        return instructionVos;
    }


    private String getDrugEngPt(JSONObject userSynonm) {
        StringBuilder pt = new StringBuilder();
        JSONArray jsonArray = userSynonm.getJSONArray("pts");
        for (JSONArray jsonArray1 : jsonArray.toJavaList(JSONArray.class)) {
            for (JSONObject jsonObject : jsonArray1.toJavaList(JSONObject.class)) {

                if (StrUtil.isNotBlank(jsonObject.getString("word")) && isChinese(jsonObject.getString("word"))) {
                    pt.append(",").append(jsonObject.getString("word"));
                }
                if (StrUtil.isNotBlank(jsonObject.getString("trans")) && isChinese(jsonObject.getString("trans"))) {
                    pt.append(",").append(jsonObject.getString("trans"));
                }

            }


        }
        return pt.length() > 0 ? pt.substring(1, pt.length()) : "";
    }

    private String getRrportDrugName(JSONObject userSynonm) {
        //设置查询药品名称只能传递英文
        StringBuilder drugName = new StringBuilder();
        JSONArray jsonArray = userSynonm.getJSONArray("drugs");
        for (JSONArray jsonArray1 : jsonArray.toJavaList(JSONArray.class)) {
            for (JSONObject jsonObject : jsonArray1.toJavaList(JSONObject.class)) {

                drugName.append(jsonObject.getString("word")).append("(").append(jsonObject.getString("trans")).append(")").append("联合");

            }
        }
        return drugName.length() > 0 ? drugName.substring(0, drugName.length() - 2) : "";
    }

    private String getDrugEnglishName(JSONObject userSynonm) {
        StringBuilder drugNames = new StringBuilder();
        if (ObjectUtils.isEmpty(userSynonm)) {
            return "";
        }

        JSONArray jsonArray = userSynonm.getJSONArray("drugs");
        for (JSONArray jsonArray1 : jsonArray.toJavaList(JSONArray.class)) {
            StringBuilder drugName = new StringBuilder();
            for (JSONObject jsonObject : jsonArray1.toJavaList(JSONObject.class)) {
                String trans = jsonObject.getString("trans");

                String word = jsonObject.getString("word");
                if (StrUtil.isNotBlank(trans) && !isChinese(trans)) {
                    drugName.append(";").append(trans);
                } else {
                    drugName.append(";").append(word);

                }
            }
            if (StrUtil.isNotEmpty(drugName)) {
                drugName = new StringBuilder(drugName.substring(1, drugName.length()));
                drugNames.append(drugName).append(",");
            }

        }
        return drugNames.length() > 0 ? drugNames.substring(0, drugNames.length() - 1) : "";
    }


    private String getDrugName(JSONObject userSynonm) {
        StringBuilder drugNames = new StringBuilder();
        if (ObjectUtils.isEmpty(userSynonm)) {
            return "";
        }

        JSONArray jsonArray = userSynonm.getJSONArray("drugs");
        for (JSONArray jsonArray1 : jsonArray.toJavaList(JSONArray.class)) {
            StringBuilder drugName = new StringBuilder();
            for (JSONObject jsonObject : jsonArray1.toJavaList(JSONObject.class)) {
                String trans = jsonObject.getString("trans");

                String word = jsonObject.getString("word");

                    drugName.append(";").append(word);

            }
            if (StrUtil.isNotEmpty(drugName)) {
                drugName = new StringBuilder(drugName.substring(1, drugName.length()));
                drugNames.append(drugName).append(",");
            }

        }
        return drugNames.length() > 0 ? drugNames.substring(0, drugNames.length() - 1) : "";
    }

    private String getDrugEnglishNamePlus(JSONObject userSynonm) {
        if (ObjectUtils.isEmpty(userSynonm)) {
            return "";
        }

        StringBuilder drugNames = new StringBuilder();
        JSONArray jsonArray = userSynonm.getJSONArray("drugs");

        for (JSONArray jsonArray1 : jsonArray.toJavaList(JSONArray.class)) {
            StringBuilder drugName = new StringBuilder();

            for (JSONObject jsonObject : jsonArray1.toJavaList(JSONObject.class)) {
                String trans = jsonObject.getString("trans");
                String word = jsonObject.getString("word");

                // 查询drug_name_tr集合中匹配的记录
                Criteria criteria = new Criteria();
                criteria.orOperator(
                        Criteria.where("drug_en").regex(word, "i"),  // 英文名匹配（忽略大小写）
                        Criteria.where("drug_zh").regex(word, "i")    // 中文名匹配（忽略大小写）
                );
                List<JSONObject> ts = mongoTemplate.find(new Query(criteria), JSONObject.class, "drug_name_tr");

                if (CollUtil.isNotEmpty(ts)) {
                    //需要先去重
                    HashSet<String> strings = new HashSet<>();
                    for (JSONObject t : ts) {
                        String string = t.getString("drug_jd");
                        if (!string.contains(",")) {
                          strings.add(string);
                        }
                    }
                    for (String string : strings) {
                        drugName.append(";").append(string);
                    }
                }

                // 根据是否智能识别模式处理药物名称
                if ("1".equals(userSynonm.getString("isIntelligent"))) {
                    // 智能识别模式
                    if (!trans.contains(",")) {
                        drugName.append(";").append(trans);
                    }

                    if (!word.contains(",")) {
                        drugName.append(";").append(word);
                    }
                } else {
                    // 非智能识别模式
                    if (!word.contains(",")) {
                        drugName.append(";").append(word);
                    }
                }
            }

            // 处理当前药物组的名称拼接
            if (StrUtil.isNotEmpty(drugName)) {
                drugName = new StringBuilder(drugName.substring(1, drugName.length()));
                drugNames.append(drugName).append(",");
            }
        }

        // 返回最终结果，去掉末尾的逗号
        return drugNames.length() > 0 ? drugNames.substring(0, drugNames.length() - 1) : "";
    }


    private String getptEnglishNamePlus(JSONObject userSynonm) {
        StringBuilder drugNames = new StringBuilder();
        if (ObjectUtils.isEmpty(userSynonm)) {
            return "";
        }

        JSONArray jsonArray = userSynonm.getJSONArray("pts");
        for (JSONArray jsonArray1 : jsonArray.toJavaList(JSONArray.class)) {
            StringBuilder drugName = new StringBuilder();
            for (JSONObject jsonObject : jsonArray1.toJavaList(JSONObject.class)) {
                String trans = jsonObject.getString("trans");
                String word = jsonObject.getString("word");
                if (trans.contains(",")) {
                    String[] split = trans.split(",");
                    for (String s : split) {
                        drugName.append(";").append(s);
                    }
                } else {
                    drugName.append(";").append(trans);
                }
                drugName.append(";").append(word);
            }
            if (StrUtil.isNotEmpty(drugName)) {
                drugName = new StringBuilder(drugName.substring(1, drugName.length()));
                drugNames.append(drugName).append(",");
            }

        }
        return drugNames.length() > 0 ? drugNames.substring(0, drugNames.length() - 1) : "";
    }

    private String getptEnglishNamePlusJd(JSONObject userSynonm) {
        StringBuilder drugNames = new StringBuilder();
        if (ObjectUtils.isEmpty(userSynonm)) {
            return "";
        }

        JSONArray jsonArray = userSynonm.getJSONArray("pts");
        for (JSONArray jsonArray1 : jsonArray.toJavaList(JSONArray.class)) {
            StringBuilder drugName = new StringBuilder();
            for (JSONObject jsonObject : jsonArray1.toJavaList(JSONObject.class)) {
                String trans = jsonObject.getString("trans");
                String word = jsonObject.getString("word");
                List<JSONObject> jsonObjects = mongoTemplate.find(new Query(Criteria.where("pt_en").is(word).orOperator(Criteria.where("pt_zh").is(word))), JSONObject.class, "race_jp_zh");
                if (CollectionUtil.isNotEmpty(jsonObjects)){
                    drugName.append(jsonObjects.get(0).getString("pt_en")).append(";");
                }
                drugName.append(";").append(word);
                if (trans.contains(",")) {
                    String[] split = trans.split(",");
                    for (String s : split) {
                        drugName.append(";").append(s);
                    }
                } else {
                    drugName.append(";").append(trans);
                }


            }
            if (StrUtil.isNotEmpty(drugName)) {
                drugName = new StringBuilder(drugName.substring(1, drugName.length()));
                drugNames.append(drugName).append(",");
            }

        }
        return drugNames.length() > 0 ? drugNames.substring(0, drugNames.length() - 1) : "";
    }

    private boolean isChinese(String str) {
        return !StrUtil.isNotBlank(str) || str.length() == str.getBytes().length;
    }


    private String getSomParam(List<String> param, List<String> l) {
        if (param != null && !param.contains("不限") && !param.containsAll(l) && CollUtil.isNotEmpty(param)) {
            StringBuilder sb = new StringBuilder();
            for (String s : l) {
                if (param.contains(s)) {
                    sb.append("1");
                } else {
                    sb.append("0");
                }
            }
            return sb.toString();
        }
        return "-1";
    }


    @Override
    public JSONObject getFda(FdaQueryCondition fdaQueryCondition) {
        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(fdaQueryCondition.getId())), JSONObject.class, "drug_adrs_search_data");
        SysUser sysUser = this.userService.getCurrentUser();
        String userId = sysUser.getUserId();
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", fdaQueryCondition.getId());
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品安全性分析");
            dataJson.put("module", "药学");
            dataJson.put("report_name", userSynonm.getString("report"));
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("药品安全性分析异常" + e.getCause());
        }
        JSONObject jsonObject = query(fdaQueryCondition, null);
        DrugAlert drugAlert = transDrugAlert(jsonObject);
        return this.searchAll(drugAlert, fdaQueryCondition);
    }


    @Override
    public JSONObject getFdaJd(FdaQueryCondition fdaQueryCondition) {
        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(fdaQueryCondition.getId())), JSONObject.class, "drug_adrs_search_data");
        SysUser sysUser = this.userService.getCurrentUser();
        String userId = sysUser.getUserId();
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", fdaQueryCondition.getId());
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品安全性分析");
            dataJson.put("module", "药学");
            dataJson.put("report_name", userSynonm.getString("report"));
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("科研选题添加机构汇总异常" + e.getCause());
        }
        JSONObject jsonObject = queryJd(fdaQueryCondition, null);
        DrugAlert drugAlert = transDrugAlert(jsonObject);
        return this.searchAllJd(drugAlert, fdaQueryCondition);
    }


    private String getDrugQuery(JSONObject userSynonm) {
        //设置查询药品名称只能传递英文
        StringBuilder drugName = new StringBuilder();
        JSONArray jsonArray = userSynonm.getJSONArray("result");
        for (JSONObject jsonObject : jsonArray.toJavaList(JSONObject.class)) {
            if ("drug".equals(jsonObject.getString("type"))) {
                drugName.append(jsonObject.getString("word")).append(" OR ").append(jsonObject.getString("trans")).append(" ").append(" AND ");
            }
        }
        return drugName.length() > 0 ? drugName.substring(0, drugName.length() - 5) : "";
    }

    @Override
    public JSONObject summary(String id) {
        SysUser sysUser = userService.getCurrentUser();
        JSONObject ans = new JSONObject();
        JSONObject userSynonym = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
        if (userSynonym == null) {
            throw new RuntimeException("query synonym not found");
        }
        ans.put("title", getRrportDrugName(userSynonym) + "安全性分析结果");
        ans.put("contributor", sysUser.getUserName());
        ans.put("organization", sysUser.getDeptName());
        ans.put("time", DateUtil.formatDate(new Date()));
        ans.put("drugName", getRrportDrugName(userSynonym));
        ans.put("purposes", "根据药物警戒数据中报告的真实数据为" + getRrportDrugName(userSynonym) + "上市后的安全风险控制和临床合理用药提供参考");
        ans.put("informationMining", "EviMed系统：（https://www.evimed.com/");
        //A.singletonList("#1 阿替利珠单抗 OR atezolizumab （含mesh和cmesh增补）")
        ans.put("evidenceBased", new ArrayList<>());
        ans.getJSONArray("evidenceBased").add("#1 " + getDrugQuery(userSynonym) + "（含mesh和cmesh增补）");
        ans.getJSONArray("evidenceBased").add("#2 不良反应 OR ADE OR 信号");
        ans.getJSONArray("evidenceBased").add("#3 #1 AND #2");
        ans.put("ADEsbox", new JSONArray());
        ans.put("ADRbox", new JSONArray());
        FdaQueryCondition fdaQueryCondition = initCondition(id);
        JSONObject data = query(fdaQueryCondition, null);
        try {
            JSONArray pt_lsit = data.getJSONArray("pt_list");
            if (CollectionUtil.isNotEmpty(pt_lsit)) {
                List<List<String>> pt_ll = new ArrayList<>();
                for (JSONArray l : pt_lsit.toJavaList(JSONArray.class)) {
                    pt_ll.add(l.toJavaList(String.class));
                }
                pt_ll.sort((a, b) -> Integer.parseInt(b.get(2)) - Integer.parseInt(a.get(2)));
                for (int i = 0; i < pt_ll.size() && i < 10; i++) {
                    JSONObject pt = new JSONObject();
                    pt.put("name", pt_ll.get(i).get(1) + " " + pt_ll.get(i).get(4));
                    pt.put("value", pt_ll.get(i).get(2));
                    ans.getJSONArray("ADEsbox").add(pt);
                }
            }
            Boolean aBoolean = data.getJSONObject("signal_dict").getBoolean("outcome");
            if (!aBoolean) {
                JSONObject signaldict = data.getJSONObject("signal_dict").getJSONObject("data");
                if (CollectionUtil.isNotEmpty(signaldict)) {
                    for (Map.Entry<String, Object> entry : signaldict.entrySet()) {
                        JSONObject organ = new JSONObject();
                        organ.put("title", entry.getKey());
                        organ.put("data", new JSONArray());
                        if (entry.getValue() instanceof List<?>) {
                            for (Object obj : (List) entry.getValue()) {
                                if (obj instanceof List<?>) {
                                    List l = (List) obj;
                                    JSONObject item = new JSONObject();
                                    item.put("name", l.get(6) + "(" + l.get(0) + ")");
                                    item.put("value", l.get(1));
                                    organ.getJSONArray("data").add(item);
                                }
                            }
                            ans.getJSONArray("ADRbox").add(organ);
                            if (ans.getJSONArray("ADRbox").size() >= 4) {
                                break;
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        List<InstructionVo> instructions = getInstructions(userSynonym);
        ans.put("specification", instructions);
        StringBuilder regex = new StringBuilder();
        List<JSONObject> policys = new ArrayList<>();
        for (String drug : fdaQueryCondition.getDrug()) {
            regex.append(drug).append("|");
        }
        if (regex.length() > 1) {
            policys.addAll(this.mongoTemplate.find(new Query(Criteria.where("conent").regex(regex.substring(0, regex.length() - 1), "i")), JSONObject.class, "yaojianju_yaowujingjie"));
        }
        for (JSONObject policy : policys) {
            policy.remove("yuanma");
            policy.remove("conent");
            policy.remove("conent_list");
        }
        ans.put("policys", policys);
        ans.put("literature", "");
        ans.put("clinicalTest", new JSONObject());
        List<JSONObject> clinicals = getCilinical(id);
        ans.getJSONObject("clinicalTest").put("quantity", clinicals.size());
        ans.getJSONObject("clinicalTest").put("content", new JSONArray());
        for (JSONObject clinical : clinicals) {
            JSONObject item = new JSONObject();
            item.put("register_no", clinical.getString("register_no"));
            item.put("register_box", clinical.getString("public_title"));
            ans.getJSONObject("clinicalTest").getJSONArray("content").add(item);
            if (ans.getJSONObject("clinicalTest").getJSONArray("content").size() >= 5) {
                break;
            }
        }
        return ans;
    }

    @Override
    public List<JSONObject> getCilinical(String id) {

        JSONObject userSynonym = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(id)), JSONObject.class, "drug_adrs_search_data");
        if (userSynonym == null) {
            throw new RuntimeException("search synonym not found");
        }
        //拼接检索式
        String drugQuery = getDrugQuerys(userSynonym);
        List<JSONObject> ans = new ArrayList<>();
        try {
            int pageNum = 1;
            do {
                ParserConfig config = new ParserConfig();
                // 可以选择启用或禁用autoType
                JSONArray cilinicals = getClinical(drugQuery, pageNum);
                pageNum++;
                config.setAutoTypeSupport(true);
                ArrayList<String> register_nos = new ArrayList<>();
                for (JSONObject cilinical : cilinicals.toJavaList(JSONObject.class)) {
                    register_nos.add(cilinical.getString("registerNo"));
                }
                Criteria exists = Criteria.where("register_no").in(register_nos).and("adverse_events").exists(true);
                Sort sort = Sort.by(Sort.Direction.DESC, "last_update_date");
                //`log.info("find cilinical : {}", registerNo);
                List<JSONObject> jsonObjects = this.mongoTemplate.find(new Query(exists).with(sort), JSONObject.class, "clinical_trial_registration_new");
                for (JSONObject cilinicalAdrs : jsonObjects) {
                    if (cilinicalAdrs != null) {
                        cilinicalAdrs = JSON.parseObject(JSON.toJSONString(cilinicalAdrs, nameFilter), JSONObject.class, config);
                        //按照前端要求对一些数值进行排序
                        List<JSONObject> s = null;
                        try {
                            s = cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("SERIOUS_ADVERSE_EVENTS").toJavaList(JSONObject.class);
                        } catch (NullPointerException e) {

                        }
                        if (ObjectUtils.isNotEmpty(s) && s.size() > 1) {
                            Map<String, List<JSONObject>> smap = new HashMap<>();
                            int i = 0;
                            while (i < s.size()) {
                                JSONObject jsonObject = s.get(i);
                                String skey = "";
                                if (jsonObject.containsKey("organ_system")) {
                                    skey = jsonObject.getString("organ_system");
                                }
                                List<JSONObject> l = smap.getOrDefault(skey, new ArrayList<>());
                                l.add(jsonObject);
                                smap.put(skey, l);
                                i++;
                            }
                            s.clear();
                            if (smap.get("") != null) {
                                s.addAll(smap.get(""));
                            }
                            for (Map.Entry<String, List<JSONObject>> entry : smap.entrySet()) {
                                if (entry.getKey().equals("")) {
                                    continue;
                                }
                                JSONObject orga_sys = new JSONObject();
                                orga_sys.put("tag", entry.getKey());
                                orga_sys.put("organ_system", entry.getKey());
                                orga_sys.put("stats", new ArrayList<>());
                                orga_sys.put("assessment_type", "");
                                orga_sys.put("source_vocabulary", "");
                                s.add(orga_sys);
                                s.addAll(entry.getValue());
                            }
                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("SERIOUS_ADVERSE_EVENTS").clear();
                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("SERIOUS_ADVERSE_EVENTS").addAll(s);
                        }
                        List<JSONObject> o = null;
                        try {
                            o = cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("OTHER_(NOT_INCLUDING_SERIOUS)_ADVERSE_EVENTS").toJavaList(JSONObject.class);
                        } catch (NullPointerException e) {
                        }
                        if (CollUtil.isNotEmpty(o)) {
                            Map<String, List<JSONObject>> omap = new HashMap<>();
                            for (JSONObject jsonObject : o) {
                                String skey = "";
                                if (jsonObject.containsKey("organ_system")) {
                                    skey = jsonObject.getString("organ_system");
                                }
                                List<JSONObject> l = omap.getOrDefault(skey, new ArrayList<>());
                                l.add(jsonObject);
                                omap.put(skey, l);
                            }
                            o.clear();
                            if (omap.get("") != null) {
                                o.addAll(omap.get(""));
                            }
                            for (Map.Entry<String, List<JSONObject>> entry : omap.entrySet()) {
                                if (entry.getKey().equals("")) {
                                    continue;
                                }
                                JSONObject orga_sys = new JSONObject();
                                orga_sys.put("tag", entry.getKey());
                                orga_sys.put("organ_system", entry.getKey());
                                orga_sys.put("stats", new ArrayList<>());
                                orga_sys.put("assessment_type", "");
                                orga_sys.put("source_vocabulary", "");
                                o.add(orga_sys);
                                o.addAll(entry.getValue());
                            }
                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("OTHER_(NOT_INCLUDING_SERIOUS)_ADVERSE_EVENTS").clear();
                            cilinicalAdrs.getJSONObject("adverse_events").getJSONArray("OTHER_(NOT_INCLUDING_SERIOUS)_ADVERSE_EVENTS").addAll(o);
                        }
                        JSONArray interventions = cilinicalAdrs.getJSONArray("intervention");
                        ArrayList<String> strings = new ArrayList<>();
                        if (CollUtil.isNotEmpty(interventions)) {
                            for (JSONObject intervention : interventions.toJavaList(JSONObject.class)) {
                                strings.add(intervention.getString("intervention_name"));
                            }
                        }
                        cilinicalAdrs.put("interventions", strings);
                        //todo 处理这个
                        cilinicalAdrs.put("lastUpdatePosted", cilinicalAdrs.getString("last_update_date"));
                        ans.add(cilinicalAdrs);
                        if (cilinicals.size() < 200 || ans.size() >= 20|| pageNum>=10) {
                            List<JSONObject> sortedAns = ans.stream()
                                    .sorted(Comparator.comparing(obj -> {
                                        Object dateObj = obj.get("lastUpdatePosted");
                                        if (dateObj == null) {
                                            return LocalDate.MIN;
                                        }
                                        DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd");
                                        LocalDate date = LocalDate.parse(dateObj.toString(), formatter);
                                        return date;
                                    }))
                                    .collect(Collectors.toList());
                            Collections.reverse(sortedAns);
                            return sortedAns;
                        }
                    }
                }

            } while (pageNum<=10);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        return ans;
    }


    private static final int TIMEOUT_SECONDS = 20; // 超时时间，单位为秒

    private JSONArray getClinical(String drugQuery, Integer pageNum) {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        Future<JSONArray> future = executor.submit(() -> {
            JSONObject clinicalQuery = JSONObject.parseObject("{\"pageNum\":1,\"pageSize\":200,\"type\":0,\"change\":[1],\"registrationTimeSort\":2,\"endRegistrationTime\":\"\",\"startRegistrationTime\":\"\",\"maxSampleSize\":\"\",\"minSampleSize\":\"\",\"searchData\":\"#{drug}\",\"studyType\":[],\"testPhase\":[]}");
            clinicalQuery.put("searches", drugQuery);
            clinicalQuery.put("pageNum", pageNum);
            JSONObject clinicalData = this.clinicalTrialFeign.getClinical(clinicalQuery);

            // 添加空值检查以避免 NullPointerException
            if (clinicalData == null) {
                return new JSONArray();
            }

            JSONObject data = clinicalData.getJSONObject("data");
            if (data == null) {
                return new JSONArray();
            }

            JSONArray clinicals = data.getJSONArray("list");
            if (clinicals == null) {
                return new JSONArray();
            }

            return clinicals;
        });

        try {
            return future.get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            future.cancel(true);
            // 处理超时情况，例如返回空数组或抛出自定义异常
            return new JSONArray();
        } catch (InterruptedException | ExecutionException e) {
            Thread.currentThread().interrupt();
            log.error(e.getMessage(), e);
            throw new RuntimeException("Error occurred while getting clinical data", e);
        } finally {
            executor.shutdownNow();
        }
    }


    private String getDrugQuerys(JSONObject userSynonym) {
        StringBuilder stringBuilder = new StringBuilder();
        JSONArray drugs = userSynonym.getJSONArray("drugs");
        for (JSONArray drug : drugs.toJavaList(JSONArray.class)) {
            ArrayList<String> strings = new ArrayList<>();
            for (JSONObject o : drug.toJavaList(JSONObject.class)) {
                strings.add(o.getString("word"));
                strings.add(o.getString("trans"));
            }
            AnalyzeConditionUtils.montageForPaper(stringBuilder, strings, "干预措施");
            stringBuilder.append(" AND ");
        }
        return stringBuilder.delete(stringBuilder.length() - 5, stringBuilder.length()).toString();

    }

    @Override
    public void saveSummary(SummaryContentVO summaryContentVO) {
        this.mongoTemplate.remove(new Query(Criteria.where("_id").is(summaryContentVO.getId())), SummaryContentVO.class);
        this.mongoTemplate.save(summaryContentVO);
    }


    private String listToString(List<String> names) {
        if (CollectionUtil.isEmpty(names)) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (String s : names) {
            if ("不限".equals(s)) {
                return "";
            }
            sb.append(s).append(",");
        }
        return sb.substring(0, sb.length() - 1);
    }


    private String listToStringJd(List<String> names) {
        if (CollectionUtil.isEmpty(names)) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (String s : names) {
            if ("不限".equals(s)) {
                return "";
            }
            List<JSONObject> jsonObjects = mongoTemplate.find(new Query(Criteria.where("pt_en").is(s)), JSONObject.class, "race_jp_zh");
            if (CollectionUtil.isNotEmpty(jsonObjects)){
                sb.append(jsonObjects.get(0).getString("pt_zh")).append(",");
            }
            sb.append(s).append(",");
        }
        return sb.substring(0, sb.length() - 1);
    }

    private JSONObject searchAll(DrugAlert drugAlert, FdaQueryCondition condition) {
        String dataName = "FAERS";
        JSONObject result = new JSONObject();

        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(condition.getId())), JSONObject.class, "drug_adrs_search_data");
        JSONArray pts = userSynonm.getJSONArray("pts");
        JSONArray drugs = userSynonm.getJSONArray("drugs");
        String ptNames = "";
        int type = 0;
        if (drugs.size() == 1 && pts.size() < 1) {
            type = 0;
        } else if (drugs.size() == 1 && pts.size() > 0) {
            type = 1;
        } else if (drugs.size() > 1 && pts.size() < 1) {
            type = 2;
        } else if (drugs.size() > 1 && pts.size() > 0) {
            type = 3;
        }

        if (pts.size() > 0) {
            for (JSONArray pt : pts.toJavaList(JSONArray.class)) {
                String string = pt.getJSONObject(0).getString("word");
                ptNames = ptNames + string + "和";
            }
            ptNames = ptNames.substring(0, ptNames.length() - 1);
        }
        String drugName = "";
        for (JSONArray drug : drugs.toJavaList(JSONArray.class)) {
            String string = drug.getJSONObject(0).getString("word");
            drugName = drugName + string + "联合";
        }
        drugName = drugName.substring(0, drugName.length() - 2);
        String query;
        if ("1".equals(userSynonm.getString("route"))) {
            query = userSynonm.getString("query");
        } else {
            query = "(" + condition.getDrugName() + ")AND(" + condition.getPt().get(0) + ")";
        }
        String dateStart = "2004-01-01";
        String dateEnd = configUtil.getConfig(ConfigEnum.FEARS_END_DATE);
        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
        if (ObjectUtils.isNotEmpty(userSynonm.getString("reportStartTime"))) {
            dateStart = simpleDateFormat.format(Long.parseLong(userSynonm.getString("reportStartTime")));
        }
        if (ObjectUtils.isNotEmpty(userSynonm.getString("reportEndTime"))) {
            dateEnd = simpleDateFormat.format(Long.parseLong(userSynonm.getString("reportEndTime")));
        }
        //drugAlert.setDrugName(Collections.emptyList());
        //加入不良反应报告的数量，用于药物警戒下载
        int allNum = 0;
        List<String> titleCount = new ArrayList<>();

        titleCount = drugAlert.getTitleCount();
        if (titleCount == null) {
            titleCount = new ArrayList<>();
            for (int i = 0; i < 7; i++) {
                titleCount.add("0");
            }
        }

        StringBuilder searchAbstract = new StringBuilder();
        searchAbstract.append("基于您输入的检索式：" + query + "\n");
        if (type != 1) {
            searchAbstract.append("本研究纳入了<span>" + dateStart + "</span>至<span>" + dateEnd + "</span>的ADE报告，共检索到与之相关的ADE报告<span>" + titleCount.get(0) + "</span>份。\n");
        } else {
            searchAbstract.append("本研究纳入了<span>" + dateStart + "</span>至<span>" + dateEnd + "</span>的ADE报告，共检索到以目标药品为PS的ADE报告为<span>" + titleCount.get(6) + "</span>份。\n");
        }
        if (type == 0&&!"0".equals(titleCount.get(0))) {
            searchAbstract.append("以<span>" + drugName + "</span>为PS的ADE报告，共<span>" + titleCount.get(1) + "</span>份。\n");
            searchAbstract.append("其中以<span>" + titleCount.get(4) + "</span>年上报数量最多(<span>" + titleCount.get(5) + "</span>份)。\n");
        }
        if ((type == 2 || type == 3) && !"0".equals(titleCount.get(1))) {
            searchAbstract.append("其中以<span>" + titleCount.get(2) + "</span>年上报数量最多(<span>" + titleCount.get(3) + "</span>份)。\n");
        } else if ("0".equals(titleCount.get(1)) && type != 1 && type != 0) {
            searchAbstract.append("其中以<span>" + titleCount.get(2) + "</span>年上报数量最多(<span>" + titleCount.get(3) + "</span>份)。\n");
        } else if (type == 1) {
            searchAbstract.append("其中导致目标不良反应的ADE报告数为<span>" + titleCount.get(1) + "</span>份。\n");
            if (!"0".equals(titleCount.get(1))) {
                searchAbstract.append("其中以<span>" + titleCount.get(4) + "</span>年上报数量最多(<span>" + titleCount.get(5) + "</span>份)。\n");
                ;
            }
        }

        if(StringUtils.isEmpty(ptNames)){

            result.put("titleName","基于美国FAERS数据库的"+drugName+"不良事件信号挖掘");
        }else {

            result.put("titleName","基于美国FAERS数据库的"+drugName+"导致"+ptNames+"不良事件信号挖掘");
        }

        if (ObjectUtils.isEmpty(drugAlert) || "0".equals(titleCount.get(0))) {
            result.put("haveSearchData", false);
            result.put("searchAbstract", searchAbstract);
            return result;
        } else {
            result.put("haveSearchData", true);
        }

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
                    allNum += parseInt;
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
                return Integer.compare(ror1, ror2);
            });
            if (reportYear.size() > 25) {
                JSONArray newYear = new JSONArray();
                for (int i1 = 0; i1 < 25; i1++) {
                    newYear.add(reportYear.getJSONObject(i1));
                }
                reportYear = newYear;
            }
        }
        reportYear.sort((o1, o2) -> {
            int ror1 = Integer.parseInt(JSONObject.parseObject(JSONObject.toJSONString(o1)).getString("name"));
            int ror2 = Integer.parseInt(JSONObject.parseObject(JSONObject.toJSONString(o2)).getString("name"));
            return Integer.compare(ror2, ror1);
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
        if (reportCountry.size() > 10) {
            reportCountry.subList(0, 10);
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
        String[] order = {"≤18岁", "18<年龄<65", "≥65岁", "未知"};

        Map<String, Integer> orderMap = new HashMap<>();
        for (int i = 0; i < order.length; i++) {
            orderMap.put(order[i], i);
        }

        // 自定义比较器
        Comparator<List<String>> customComparator = (list1, list2) -> {
            String key1 = (String) list1.get(1);
            String key2 = (String) list2.get(1);
            return Integer.compare(orderMap.getOrDefault(key1, order.length), orderMap.getOrDefault(key2, order.length));
        };
        List<List<String>> sortedAgeList = ageList.stream()
                .sorted(customComparator)
                .collect(Collectors.toList());
        String maxAge = "";
        if (CollUtil.isNotEmpty(sortedAgeList)) {
            int maxNum = Integer.MIN_VALUE;
            for (List<String> list : sortedAgeList) {
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
                    weightMap.put("未知", weightMap.get("未知") + Long.parseLong(num));
                } else {
                        /*
                        int anInt = Integer.parseInt(name);
                        if (anInt < 50) {
                            weightMap.put("<50kg", weightMap.get("<50kg") + Long.parseLong(num));
                        } else if (anInt > 100) {
                            weightMap.put("50~100kg", weightMap.get("50~100kg") + Long.parseLong(num));
                        } else {
                            weightMap.put(">100kg", weightMap.get(">100kg") + Long.parseLong(num));
                        }*/

                    weightMap.put(name, weightMap.get(name) + Long.parseLong(num));
                }

            }
        }
        long maxLong = Long.MIN_VALUE;
        Set<Map.Entry<String, Long>> entries1 = weightMap.entrySet();
        for (Map.Entry<String, Long> stringLongEntry : entries1) {
            String key = stringLongEntry.getKey();
            Long value = stringLongEntry.getValue();
            if (!"未知".equals(key)) {
                if (maxLong < value) {
                    maxLong = value;
                    maxWeight = key;
                }
            } else {
                //todo 暂时先这样跳过，不知道之前为什么这里跟其他地方不一致，导致跳过未知功能无法统一处理
                if (value == 0) {
                    continue;
                }
            }
            JSONObject inner = new JSONObject();
            inner.put("name", key);
            inner.put("num", value);
            String divide;
            if (sum == 0) {
                divide = "0";
            } else {
                double valuex = BigDecimal.valueOf(value).multiply(BigDecimal.valueOf(100)).divide(BigDecimal.valueOf(sum), 2, RoundingMode.HALF_UP).doubleValue();
                DecimalFormat decimalFormat = new DecimalFormat("0.00");
                divide = decimalFormat.format(valuex) + "%";
            }
            inner.put("percentage", divide);
            reportWeight.add(inner);
        }
        result.getJSONObject("basicInformation").getJSONObject("populationDistribution").put("reportWeight", reportWeight);
        if (StringUtils.isNotEmpty(maxWeight) && !"unknown".equals(maxWeight)) {
            //体重分布结论
            result.getJSONObject("basicInformation").getJSONObject("populationDistribution").put("weight", "在" + dataName + "数据库报的不良反应报告中，占比较高的体重分布在" + maxWeight + "。");
        } else {
            result.getJSONObject("basicInformation").getJSONObject("populationDistribution").put("weight", "");
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
            /*if (routeList.size() > 5) {
                routeList = routeList.subList(0, 5);
            }*/
            int maxNum = Integer.MIN_VALUE;
            int count = 1;
            int countRoute = 0;
            for (List<String> list : routeList) {
                String jpName = list.get(1);
                //todo
                String name = list.get(4);
                String num = list.get(2);
                try {
                    int parseInt = Integer.parseInt(num);
                    if (parseInt > maxNum) {
                        if (!"未知".equals(name)) {
                            maxNum = parseInt;
                            maxRoute = "大部分通过" + jpName + "给药";
                        }
                    }
                    countRoute += parseInt;
                } catch (NumberFormatException e) {
                    log.error("将字符串类型的数量转化成int类型异常");
                }
                String percentage = list.get(3);
                JSONObject inner = new JSONObject();
                inner.put("englishName", jpName);
                inner.put("name", name);
                inner.put("num", num);
                inner.put("percentage", percentage);
                route.add(inner);
                if (count++ >= 5) {
                    break;
                }



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
            int count = 0;
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
                /*if (doseAmt.size() >= 5) {
                    break;
                }*/
                doseAmt.add(inner);
//                if (++count >= 5) {
//                    break;
//                }
            }

        }
        result.getJSONObject("drugAnalysis").getJSONObject("usageAndDosage").put("doseAmt", doseAmt);
        if (StringUtils.isNotEmpty(maxDrug) || StringUtils.isNotEmpty(maxForm) || StringUtils.isNotEmpty(maxRoute) || StringUtils.isNotEmpty(maxdoseAmt)) {
            StringBuilder usageAndDosageExplain = new StringBuilder();
            usageAndDosageExplain.append("在").append(dataName).append("数据库上报的不良反应报告中");
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
                if (durTime.size() >= 5) {
                    break;
                }
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
                if (cutDtTime.size() >= 5) {
                    break;
                }
            }
        }
        result.getJSONObject("drugAnalysis").getJSONObject("time").put("cutDtTime", cutDtTime);
        if (StringUtils.isNotEmpty(maxDruTime) || StringUtils.isNotEmpty(maxCutDtTime)) {
            StringBuilder timeExplain = new StringBuilder();
            timeExplain.append("在").append(dataName).append("数据库上报的不良反应报告中，使用").append(drugName).append("后，");
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
            maxIndiPt1 = indiPtList.get(0).get(4);
            int index = 1;
            while (maxIndiPt1.contains("未知") && indiPtList.size() > index) {
                maxIndiPt1 = indiPtList.get(index).get(4);
                index++;
            }
            if (indiPtList.size() > index) {
                maxIndiPt2 = indiPtList.get(index).get(4);
                index++;
                while (maxIndiPt2.contains("未知") && indiPtList.size() > index) {
                    maxIndiPt2 = indiPtList.get(index).get(4);
                    index++;
                }
            }
            //todo
            for (List<String> list : indiPtList) {
                String englishName = list.get(1);
                String name = list.get(4);
                String num = list.get(2);
                String percentage = list.get(3);
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
            indiPtBuilder.append("在").append(dataName).append("数据库上报的不良反应报告中，使用").append(drugName).append("的适应症最多的是").append(maxIndiPt1).append(",");
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
        int ptNum = ObjectUtils.isNotEmpty(drugAlert.getPtNum()) ? drugAlert.getPtNum() : 0;
        if (CollUtil.isNotEmpty(ptList)) {
            String pt = drugAlert.getPt();
            try {
                String[] split = pt.split(",");
                ptNum = split.length;
            } catch (Exception e) {
                log.error("使用全部不良反应");
            }
            int startPtIndex = 0;
            if (CollectionUtil.isNotEmpty(ptList) && StrUtil.equals(ptList.get(0).get(1), "unknown")) {
                startPtIndex = 1;
            }
            if (ptList.size() > 2 + startPtIndex) {
                maxPt = ptList.get(startPtIndex).get(4) + "、" + ptList.get(startPtIndex + 1).get(4) + "和" + ptList.get(2 + startPtIndex).get(4) + "等";
            } else if (ptList.size() > 1 + startPtIndex) {
                maxPt = ptList.get(0).get(4) + "和" + ptList.get(1).get(4);
            } else if (ptList.size() == 1 + startPtIndex) {
                maxPt = ptList.get(0).get(4);
            }
            for (List<String> list : ptList) {
                String englishName = list.get(1);
                String name = list.get(4);
                String num = list.get(2);
                String percentage = list.get(3);
                //String diseaseType = list.get(4);
                JSONObject inner = new JSONObject();
                inner.put("englishName", englishName);
                inner.put("name", name);
                inner.put("num", num);
                inner.put("percentage", percentage);
                //inner.put("diseaseType", diseaseType);
                ptData.add(inner);
            }
        }
        result.getJSONObject("adverseReactionSignal").put("pt", ptData);
        if (StringUtils.isNotEmpty(maxPt)) {
            result.getJSONObject("adverseReactionSignal").put("ptExplain", "在" + dataName + "数据库上报的不良反应报告中，监测出不良反应共有" + ptNum + "个，其中最常见的有" + maxPt);
        }
        // 2、典型信号分析 signal_dict i和i+o显示的效果不同
        //保存用于计算信号图i和o
        boolean flagPicture = true;
        List<JSONObject> pictureCondition = new ArrayList<>();


        if (drugs.size() > 0 && pts.size() > 0) {
            //i+o
            String s1 = null;
            Adrs adrs = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("description").in(pts.getJSONArray(0).getJSONObject(0).getString("trans")).and("type").is("drugname")), Adrs.class);
            Adrs adrs1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("description").in(pts.getJSONArray(0).getJSONObject(0).getString("word")).and("type").is("drugname")), Adrs.class);
            String judge = "不属于";
            if (adrs != null || adrs1 != null) {
                String indicator = "";
                if (adrs != null) {
                    indicator = adrs.getIndicator();
                } else {
                    indicator = adrs1.getIndicator();
                }
                if ("+".equals(indicator)) {
                    judge = "属于";
                }
                JSONObject inner = new JSONObject();
                inner.put("i", condition.getDrugName());
                inner.put("o", condition.getPt());
                pictureCondition.add(inner);
            }
            s1 = ptNames + judge + drugName + "的典型信号。";
            result.getJSONObject("adverseReactionSignal").put("signalDictExplain", s1);
            Update update = new Update();
            update.set("prop1", s1);
            mongoTemplate.updateFirst(new Query(Criteria.where("_id").is(condition.getId())), update, "drug_adrs_search_data");
            if (type == 1) {
                searchAbstract.append("<span>" + s1 + "</span>");
            }

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
                    String[] split = key.split("[(（]");
                    String name = "";
                    try {
                        name = split[1].replaceAll("\\)|）", "").trim();
                        if (!GetMaxSimilarUtil.judgeChinese(name)) {
                            name = split[2].replaceAll("\\)", "").trim();
                        }
                    } catch (Exception e) {
                        log.error(e.toString());
                    }
                    for (List<String> list : value) {
                        numCount++;
                        JSONObject innerJson = new JSONObject();
                        String innerName = list.get(10);
                        String englishName = list.get(0);
                        String num = list.get(1);
                        String ror = list.get(3);
                        String ebgm = list.get(4);
                        String ic = list.get(5);

                        String rorPro = "("+list.get(6)+","+list.get(7)+")";
                        String icPro = "("+list.get(8)+","+list.get(9)+")";

                        innerJson.put("outEnglishName", split[0]);
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
                        innerJson.put("rorPro", rorPro);
                        innerJson.put("icPro",icPro);
                        //outName单纯英文显示
                        //String outEnglish = key.replaceAll("\\(|（.* " + name + " \\)|）", "").trim();
                        innerJson.put("outEnglish", split[0]);
                        if (ror.contains(".")) {
                            int rorIndex = ror.indexOf(".");
                            try {
                                innerJson.put("ror", ror);
                            } catch (Exception e) {
                                e.printStackTrace();
                                innerJson.put("ror", ror);
                            }
                        } else {
                            innerJson.put("ror", ror);
                        }
                        if (ebgm.contains(".")) {
                            int ebgmIndex = ebgm.indexOf(".");
                            try {
                                innerJson.put("ebgm", ebgm.substring(0, ebgmIndex + 2));
                            } catch (Exception e) {
                                e.printStackTrace();
                                innerJson.put("ebgm", ebgm);
                            }
                        } else {
                            innerJson.put("ebgm", ebgm);
                        }
                        if (ic.contains(".")) {
                            int icIndex = ic.indexOf(".");
                            try {
                                innerJson.put("ic", ic.substring(0, icIndex + 2));
                            } catch (Exception e) {
                                e.printStackTrace();
                                innerJson.put("ic", ic);
                            }
                        } else {
                            innerJson.put("ic", ic);
                        }

                        //存放i+o
                        innerJson.put("i", condition != null ? condition.getDrugName() : "");
                        innerJson.put("o", condition != null ? condition.getPt() : new ArrayList<>());
                        //中文名
                        //innerJson.put("name", innerName);
                        signalDictData.add(innerJson);
                    }
                }
            }

            //按照ror排序并取前50
            if (!signalDictData.isEmpty()) {
                List<JSONObject> list = JSONArray.parseArray(JSONObject.toJSONString(signalDictData), JSONObject.class);
                try {

                    list.sort((o1, o2) -> {
                        double ror1 = Double.parseDouble(o1.getString("ror"));
                        double ror2 = Double.parseDouble(o2.getString("ror"));
                        return Double.compare(ror2, ror1);
                    });
                } catch (Exception e) {
                    e.printStackTrace();
                }
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

            JSONArray signalDictData1 = getSignalDictData(drugAlert.getSignalDict2(), allNum, condition, pictureCondition, 1);
            JSONArray signalDictData2 = getSignalDictData(drugAlert.getSignalDict3(), allNum, condition, pictureCondition, 2);
            JSONArray signalDictData3 = getSignalDictData(drugAlert.getSignalDict4(), allNum, condition, pictureCondition, 3);

            result.getJSONObject("adverseReactionSignal").put("signalDict1", signalDictData);
            result.getJSONObject("adverseReactionSignal").put("signalDict", signalDictData);
            result.getJSONObject("adverseReactionSignal").put("signalDict2", signalDictData1);
            result.getJSONObject("adverseReactionSignal").put("signalDict3", signalDictData2);
            result.getJSONObject("adverseReactionSignal").put("signalDict4", signalDictData3);
            try {
                result.getJSONObject("adverseReactionSignal").put("signalDictExplain", "在" + dataName + "数据库上报的不良反应报告中，监测出不良反应信号共有" + drugAlert.getDataTotal() + "个," + "其中最常见的有" +

                        signalDictData.getJSONObject(0).getString("name") + "," + signalDictData.getJSONObject(1).getString("name") + "和" + signalDictData.getJSONObject(2).getString("name") + "。");
            } catch (Exception e) {
                log.error("计算信号字典解释时异常", e);
            }

            result.getJSONObject("adverseReactionSignal").put("signalDictTypeCount", typeCount);
            result.getJSONObject("adverseReactionSignal").put("signalDictNumCount", numCount);
        }
        result.put("searchAbstract", searchAbstract);
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
                    inner.put("marker", outcomeCod.get(name));
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
            if (totalNum > 0) {
                JSONArray adversePercentage = new JSONArray();
                JSONObject innerAdverse1 = new JSONObject();
                BigDecimal nonAdversePercentage = BigDecimal.valueOf(100)
                        .subtract(BigDecimal.valueOf(nonAdverseNum).divide(BigDecimal.valueOf(totalNum), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)))
                        .setScale(2, RoundingMode.HALF_UP); // 保留两位小数
                DecimalFormat decimalFormat = new DecimalFormat("0.00");
                String formattedValue = decimalFormat.format(nonAdversePercentage);
                double doubleValue1 = nonAdversePercentage.doubleValue();
                innerAdverse1.put("name", "严重不良反应");
                innerAdverse1.put("num", adverseNum);
                innerAdverse1.put("percentage", doubleValue1 + "%");
                adversePercentage.add(innerAdverse1);
                JSONObject innerAdverse2 = new JSONObject();
                innerAdverse2.put("name", "非严重不良反应");
                innerAdverse2.put("num", nonAdverseNum);
                String formattedValue1 = decimalFormat.format(100 - doubleValue1);
                innerAdverse2.put("percentage", formattedValue1 + "%");
                adversePercentage.add(innerAdverse2);
                result.getJSONObject("outcomeAnalysis").put("adversePercentage", adversePercentage);
                if (StringUtils.isNotEmpty(max1)) {
                    StringBuilder inner = new StringBuilder();
                    inner.append("在").append(dataName).append("数据库上报的不良反应报告中，严重不良反应占比为").append(formattedValue).append("%，其中").append(max1).append("占比最高");
                    if (StringUtils.isNotEmpty(max2)) {
                        inner.append("，其次是").append(max2);
                    }
                    inner.append("。");
                    result.getJSONObject("outcomeAnalysis").put("adverseExplain", inner.toString());
                }
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
            //todo
            for (List<String> list : dechal) {
                String name = list.get(1);
                String num = list.get(2);
                String percentage = list.get(3);
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
            //todo
            for (List<String> list : rechal) {
                String name = list.get(1);
                String num = list.get(2);
                String percentage = list.get(3);
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
            inner.append("在").append(dataName).append("数据库上报的不良反应报告中");
            inner.append(dechalExplain);
            if (StringUtils.isNotEmpty(rechalExplain)) {
                inner.append(rechalExplain);
            }
            inner.append("。");
            // 修复StringBuilder不能被MongoDB序列化的问题，确保转换为String类型
            result.getJSONObject("outcomeAnalysis").put("dechalAndRechalExplain", inner.toString());
        }

        JSONObject object = new JSONObject();
        object.put("result", result.toJSONString());
        object.put("_id", condition.getId());
        //mongo存储一份数据
        mongoTemplate.remove(new  Query(Criteria.where("_id").is(condition.getId())), "faers_data");
        mongoTemplate.insert(object, "faers_data");
        return result;
    }


    private JSONArray getSignalDictData(Map<String, List<List<String>>> signalDict,int allNum,FdaQueryCondition condition,List<JSONObject> pictureCondition,int type){
        JSONArray signalDictData = new JSONArray();
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
                String[] split = key.split("[(（]");
                String name = "";
                try {
                    name = split[1].replaceAll("\\)|）", "").trim();
                    if (!GetMaxSimilarUtil.judgeChinese(name)) {
                        name = split[2].replaceAll("\\)", "").trim();
                    }
                } catch (Exception e) {
                    log.error(e.toString());
                }
                for (List<String> list : value) {
                    numCount++;
                    JSONObject innerJson = new JSONObject();
                    String innerName = list.get(10);
                    String englishName = list.get(0);
                    String num = list.get(1);
                    String ror = list.get(3);
                    String ebgm = list.get(4);
                    String ic = list.get(5);
                    String rorPro = "("+list.get(6)+","+list.get(7)+")";
                    String icPro = "("+list.get(8)+","+list.get(9)+")";
                    innerJson.put("outEnglishName", split[0]);
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
                    //String outEnglish = key.replaceAll("\\(|（.* " + name + " \\)|）", "").trim();
                    innerJson.put("outEnglish", split[0]);
                    innerJson.put("rorPro", rorPro);
                    innerJson.put("icPro", icPro);
                    if (ror.contains(".")) {
                        int rorIndex = ror.indexOf(".");
                        try {
                            innerJson.put("ror", ror);
                        } catch (Exception e) {
                            e.printStackTrace();
                            innerJson.put("ror", ror);
                        }
                    } else {
                        innerJson.put("ror", ror);
                    }
                    if (ebgm.contains(".")) {
                        int ebgmIndex = ebgm.indexOf(".");
                        try {
                            innerJson.put("ebgm", ebgm.substring(0, ebgmIndex + 2));
                        } catch (Exception e) {
                            e.printStackTrace();
                            innerJson.put("ebgm", ebgm);
                        }
                    } else {
                        innerJson.put("ebgm", ebgm);
                    }
                    if (ic.contains(".")) {
                        int icIndex = ic.indexOf(".");
                        try {
                            innerJson.put("ic", ic.substring(0, icIndex + 2));
                        } catch (Exception e) {
                            e.printStackTrace();
                            innerJson.put("ic", ic);
                        }
                    } else {
                        innerJson.put("ic", ic);
                    }

                    //存放i+o
                    innerJson.put("i", condition != null ? condition.getDrugName() : "");
                    innerJson.put("o", condition != null ? condition.getPt() : new ArrayList<>());
                    //中文名
                    //innerJson.put("name", innerName);
                    signalDictData.add(innerJson);
                }
            }
        }

        //按照ror排序并取前50
        if (!signalDictData.isEmpty()) {
            List<JSONObject> list = JSONArray.parseArray(JSONObject.toJSONString(signalDictData), JSONObject.class);
            try {
                String name = "";
                if (type == 0){
                    name = "ror";
                }else if (type == 1){
                    name = "ic";
                }else if (type == 2){
                    name = "ebgm";
                }else if (type == 3){
                    name = "num";
                }
                String finalName = name;
                list.sort((o1, o2) -> {
                    double ror1 = Double.parseDouble(o1.getString(finalName));
                    double ror2 = Double.parseDouble(o2.getString(finalName));
                    return Double.compare(ror2, ror1);
                });
            } catch (Exception e) {
                e.printStackTrace();
            }
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



        return signalDictData;
    }


    private JSONObject searchAllJd(DrugAlert drugAlert, FdaQueryCondition condition) {
        String dataName = "JADER";
        JSONObject result = new JSONObject();

        JSONObject userSynonm = this.mongoTemplate.findOne(new Query(Criteria.where("_id").is(condition.getId())), JSONObject.class, "drug_adrs_search_data");
        JSONArray pts = userSynonm.getJSONArray("pts");
        JSONArray drugs = userSynonm.getJSONArray("drugs");
        String ptNames = "";
        int type = 0;
        if (drugs.size() == 1 && pts.size() < 1) {
            type = 0;
        } else if (drugs.size() == 1 && pts.size() > 0) {
            type = 1;
        } else if (drugs.size() > 1 && pts.size() < 1) {
            type = 2;
        } else if (drugs.size() > 1 && pts.size() > 0) {
            type = 3;
        }

        if (pts.size() > 0) {
            for (JSONArray pt : pts.toJavaList(JSONArray.class)) {
                String string = pt.getJSONObject(0).getString("word");
                ptNames = ptNames + string + "和";
            }
            ptNames = ptNames.substring(0, ptNames.length() - 1);
        }
        String drugName = "";
        for (JSONArray drug : drugs.toJavaList(JSONArray.class)) {
            String string = drug.getJSONObject(0).getString("word");
            drugName = drugName + string + "联合";
        }
        drugName = drugName.substring(0, drugName.length() - 2);
        String query;
        if ("1".equals(userSynonm.getString("route"))) {
            query = userSynonm.getString("query");
        } else {
            query = "(" + condition.getDrugName() + ")AND(" + condition.getPt().get(0) + ")";
        }
        String dateStart = "2004-01-01";
        String dateEnd = configUtil.getConfig(ConfigEnum.FEARS_END_DATE_JD);
        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
        if (ObjectUtils.isNotEmpty(userSynonm.getString("reportStartTime"))) {
            dateStart = simpleDateFormat.format(Long.parseLong(userSynonm.getString("reportStartTime")));
        }
        if (ObjectUtils.isNotEmpty(userSynonm.getString("reportEndTime"))) {
            dateEnd = simpleDateFormat.format(Long.parseLong(userSynonm.getString("reportEndTime")));
        }
        //drugAlert.setDrugName(Collections.emptyList());
        //加入不良反应报告的数量，用于药物警戒下载
        int allNum = 0;
        List<String> titleCount = new ArrayList<>();

        titleCount = drugAlert.getTitleCount();
        if (titleCount == null) {
            titleCount = new ArrayList<>();
            for (int i = 0; i < 7; i++) {
                titleCount.add("0");
            }
        }
        String adeTotle = drugAlert.getAdeTotle();
        StringBuilder searchAbstract = new StringBuilder();
        searchAbstract.append("基于您输入的检索式：" + query + "\n");
        if (type == 0) {
            searchAbstract.append("1. 本研究纳入了" + dateStart + "至" + dateEnd + "的ADE报告，共<span>" + adeTotle + "</span>份。\n" +
                    "2. 以" + drugName + "为怀疑药物的ADE报告，共" + titleCount.get(1) + "份。\n"
                    );
            if(Integer.parseInt(titleCount.get(1))!=0){
                searchAbstract.append("3. 其中以" + titleCount.get(4) + "年上报数量最多（<span>" + titleCount.get(5) + "</span>份）。");
            }
        } else if (type == 1) {
            searchAbstract.append("1. 本研究纳入了" + dateStart + "至" + dateEnd + "的ADE报告，共<span>" + adeTotle + "</span>份。\n" +
                    "2. 以" + drugName + "为怀疑药物，且导致"+ptNames+"的ADE报告，共<span>" + titleCount.get(1) + "</span>份。\n" );
            if(Integer.parseInt(titleCount.get(1))!=0){
                searchAbstract.append("3. 其中以" + titleCount.get(4) + "年上报数量最多（<span>" + titleCount.get(5) + "</span>份）。");
            }
        } else if (type == 2) {
            searchAbstract.append("1. 本研究纳入了" + dateStart + "至" + dateEnd + "的ADE报告，共<span>" + adeTotle + "</span>份。\n" +
                    "2. 以" + drugName + "为怀疑药物的ADE报告，共" + titleCount.get(1) + "份。\n" );
            if(Integer.parseInt(titleCount.get(1))!=0){
                searchAbstract.append("3. 其中以" + titleCount.get(4) + "年上报数量最多（</span>" + titleCount.get(5) + "</span>份）。");
            }
        } else if (type == 3) {
            searchAbstract.append("1. 本研究纳入了" + dateStart + "至" + dateEnd + "的ADE报告，共<span>" + adeTotle + "</span>份。\n" +
                    "2. 以" + drugName + "为怀疑药物，且导致"+ptNames+"的ADE报告共" + titleCount.get(1) + "份。\n" );
            if(Integer.parseInt(titleCount.get(1))!=0){
                searchAbstract.append("3. 其中以" + titleCount.get(4) + "年上报数量最多（<span>" + titleCount.get(5) + "</span>份）。");
            }
        }

        if (ObjectUtils.isEmpty(drugAlert) ) {
            result.put("haveSearchData", false);
            result.put("searchAbstract", searchAbstract);
            return result;
        } else {
            result.put("haveSearchData", true);
        }

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
                    allNum += parseInt;
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
                return Integer.compare(ror1, ror2);
            });
            if (reportYear.size() > 25) {
                JSONArray newYear = new JSONArray();
                for (int i1 = 0; i1 < 25; i1++) {
                    newYear.add(reportYear.getJSONObject(i1));
                }
                reportYear = newYear;
            }
        }
        reportYear.sort((o1, o2) -> {
            int ror1 = Integer.parseInt(JSONObject.parseObject(JSONObject.toJSONString(o1)).getString("name"));
            int ror2 = Integer.parseInt(JSONObject.parseObject(JSONObject.toJSONString(o2)).getString("name"));
            return Integer.compare(ror2, ror1);
        });
        result.getJSONObject("basicInformation").getJSONObject("reportDistribution").put("reportYear", reportYear);
        JSONArray reportType = new JSONArray();
        List<List<String>> reporterTypeList = drugAlert.getReportType();
        String maxType1 = "";
        if (CollUtil.isNotEmpty(reporterTypeList)) {
            int maxIntType = Integer.MIN_VALUE;
            for (List<String> list : reporterTypeList) {
                String name = list.get(1);
                String num = list.get(2);
                try {
                    int anInt = Integer.parseInt(num);
                    if (!"不明".equals(name)) {
                        if (anInt > maxIntType) {
                            maxIntType = anInt;
                            maxType1 = name;
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
                reportType.add(inner);
            }
        }
        result.getJSONObject("basicInformation").getJSONObject("reportDistribution").put("reportType", reportType);


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


        if (StringUtils.isNotEmpty(maxYear) || StringUtils.isNotEmpty(maxName) || StringUtils.isNotEmpty(maxType1)) {

            StringBuilder yearAndCountry = new StringBuilder();
            yearAndCountry.append("在").append(dataName).append("数据库上报的不良反应报告中");
            if (StringUtils.isNotEmpty(maxYear)) {
                yearAndCountry.append("在").append(maxYear).append("年达到峰值");
            }
            if (StringUtils.isNotEmpty(maxType1)) {
                yearAndCountry.append("，以").append(maxType1).append("上报居多");
            }
            if (StringUtils.isNotEmpty(maxName)) {
                yearAndCountry.append("，以").append(maxName).append("上报居多");
            }
            yearAndCountry.append("。");
            result.getJSONObject("basicInformation").getJSONObject("reportDistribution").put("yearAndOccupation", yearAndCountry.toString());
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
        String[] order = {"≤18岁", "18＜年龄＜65", "≥65岁", "未知"};

        Map<String, Integer> orderMap = new HashMap<>();
        for (int i = 0; i < order.length; i++) {
            orderMap.put(order[i], i);
        }

        // 自定义比较器
        Comparator<List<String>> customComparator = (list1, list2) -> {
            String key1 = (String) list1.get(1);
            String key2 = (String) list2.get(1);
            return Integer.compare(orderMap.getOrDefault(key1, order.length), orderMap.getOrDefault(key2, order.length));
        };
        List<List<String>> sortedAgeList = ageList.stream()
                .sorted(customComparator)
                .collect(Collectors.toList());
        String maxAge = "";
        if (CollUtil.isNotEmpty(sortedAgeList)) {
            int maxNum = Integer.MIN_VALUE;
            for (List<String> list : sortedAgeList) {
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


        //体重分布  区间显示
        JSONArray reportWeight = new JSONArray();
        List<List<String>> wtList = drugAlert.getWtList();
        String maxWeight = "";
        long sum = 0L;
        Map<String, Long> weightMap = new LinkedHashMap<>();
        if (CollUtil.isNotEmpty(wtList)) {
            for (List<String> list : wtList) {
                String name = list.get(1);
                String num = list.get(2);
                //String percentage = list.get(3);
                sum = sum + Long.parseLong(num);
                if ("未知".equals(name)) {
                    weightMap.put("未知", Long.parseLong(num));
                } else {
                        /*
                        int anInt = Integer.parseInt(name);
                        if (anInt < 50) {
                            weightMap.put("<50kg", weightMap.get("<50kg") + Long.parseLong(num));
                        } else if (anInt > 100) {
                            weightMap.put("50~100kg", weightMap.get("50~100kg") + Long.parseLong(num));
                        } else {
                            weightMap.put(">100kg", weightMap.get(">100kg") + Long.parseLong(num));
                        }*/

                    weightMap.put(name, Long.parseLong(num));
                }

            }
        }
        long maxLong = Long.MIN_VALUE;
        Set<Map.Entry<String, Long>> entries1 = weightMap.entrySet();
        for (Map.Entry<String, Long> stringLongEntry : entries1) {
            String key = stringLongEntry.getKey();
            Long value = stringLongEntry.getValue();
            if (!"未知".equals(key)) {
                if (maxLong < value) {
                    maxLong = value;
                    maxWeight = key;
                }
            } else {
                //todo 暂时先这样跳过，不知道之前为什么这里跟其他地方不一致，导致跳过未知功能无法统一处理
                if (value == 0) {
                    continue;
                }
            }
            JSONObject inner = new JSONObject();
            inner.put("name", key);
            inner.put("num", value);
            String divide;
            if (sum == 0) {
                divide = "0";
            } else {
                double valuex = BigDecimal.valueOf(value).multiply(BigDecimal.valueOf(100)).divide(BigDecimal.valueOf(sum), 2, RoundingMode.HALF_UP).doubleValue();
                DecimalFormat decimalFormat = new DecimalFormat("0.00");
                divide = decimalFormat.format(valuex) + "%";
            }
            inner.put("percentage", divide);
            reportWeight.add(inner);
        }
        result.getJSONObject("basicInformation").getJSONObject("populationDistribution").put("reportWeight", reportWeight);
        if (StringUtils.isNotEmpty(maxType) || StringUtils.isNotEmpty(maxAge)) {
            //性别分布+年龄分布结论
            StringBuilder sexAndAge = new StringBuilder();
            sexAndAge.append("在").append(dataName).append("数据库上报的不良反应报告中");
            if (StringUtils.isNotEmpty(maxType)) {
                sexAndAge.append("，").append(maxType);
            }
            if (StringUtils.isNotEmpty(maxAge)) {
                sexAndAge.append("，年龄大多分布在").append(maxAge).append("岁");
            }
            if (StringUtils.isNotEmpty(maxWeight) && !"unknown".equals(maxWeight)) {
                sexAndAge.append("，体重大多分布在").append(maxWeight).append("kg");
            }

            sexAndAge.append("。");
            result.getJSONObject("basicInformation").getJSONObject("populationDistribution").put("sexAndAgeAndWeight", sexAndAge.toString());
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
            /*if (routeList.size() > 5) {
                routeList = routeList.subList(0, 5);
            }*/
            int maxNum = Integer.MIN_VALUE;
            int count = 1;
            for (List<String> list : routeList) {
                String jpName = list.get(1);
                //todo
                String name = list.get(4);
                String num = list.get(2);
                try {
                    int parseInt = Integer.parseInt(num);
                    if (parseInt > maxNum) {
                        if (!"未知".equals(name)) {
                            maxNum = parseInt;
                            maxRoute = "大部分通过" + jpName + "给药";
                        }
                    }
                } catch (NumberFormatException e) {
                    log.error("将字符串类型的数量转化成int类型异常");
                }
                String percentage = list.get(3);
                JSONObject inner = new JSONObject();
                inner.put("jpName", jpName);
                inner.put("name", name);
                inner.put("num", num);
                inner.put("percentage", percentage);
                route.add(inner);
                if (count++ >= 5) {
                    break;
                }
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
            int count = 0;
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
                /*if (doseAmt.size() >= 5) {
                    break;
                }*/
                doseAmt.add(inner);
//                if (++count >= 5) {
//                    break;
//                }
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
            usageAndDosageExplain.append("在").append(dataName).append("数据库上报的不良反应报告中");
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
                if (durTime.size() >= 5) {
                    break;
                }
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
                if (cutDtTime.size() >= 5) {
                    break;
                }
            }
        }
        result.getJSONObject("drugAnalysis").getJSONObject("time").put("cutDtTime", cutDtTime);
        if (StringUtils.isNotEmpty(maxDruTime) || StringUtils.isNotEmpty(maxCutDtTime)) {
            StringBuilder timeExplain = new StringBuilder();
            timeExplain.append("在").append(dataName).append("数据库上报的不良反应报告中，使用").append(listToString(drugAlert.getDrugName())).append("后，");
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
            maxIndiPt1 = indiPtList.get(0).get(1);
            int index = 1;
            while (maxIndiPt1.contains("未知") && indiPtList.size() > index) {
                maxIndiPt1 = indiPtList.get(index).get(1);
                index++;
            }
            if (indiPtList.size() > index) {
                maxIndiPt2 = indiPtList.get(index).get(1);
                index++;
                while (maxIndiPt2.contains("未知") && indiPtList.size() > index) {
                    maxIndiPt2 = indiPtList.get(index).get(1);
                    index++;
                }
            }
            //todo
            for (List<String> list : indiPtList) {
                String jpName = list.get(1);
                String name = list.get(4);
                String num = list.get(2);
                String percentage = list.get(3);
                JSONObject inner = new JSONObject();
                inner.put("jpName", jpName);
                List<JSONObject> jsonObjects = mongoTemplate.find(Query.query(Criteria.where("pt_en").is(jpName)), JSONObject.class, "pt_jd_data");
                if (CollUtil.isNotEmpty(jsonObjects)) {
                    JSONObject jsonObject = jsonObjects.get(0);
                    String string = jsonObject.getString("pt_ch");
                    inner.put("name", string);
                }
                if (StringUtils.isEmpty(name)){
                    inner.put("name", DeeplApi.trans(jpName));
                }
                inner.put("num", num);
                inner.put("percentage", percentage);
                indiPt.add(inner);
            }
        }
        result.getJSONObject("drugAnalysis").put("indiPt", indiPt);
        if (StringUtils.isNotEmpty(maxIndiPt1)) {
            StringBuilder indiPtBuilder = new StringBuilder();
            indiPtBuilder.append("在").append(dataName).append("数据库上报的不良反应报告中，使用").append(drugName).append("的适应症最多的是").append(maxIndiPt1).append(",");
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
        int ptNum = ObjectUtils.isNotEmpty(drugAlert.getPtNum()) ? drugAlert.getPtNum() : 0;
        if (CollUtil.isNotEmpty(ptList)) {
            String pt = drugAlert.getPt();
            try {
                String[] split = pt.split(",");
                ptNum = split.length;
            } catch (Exception e) {
                log.error("使用全部不良反应");
            }
            int startPtIndex = 0;
            if (CollectionUtil.isNotEmpty(ptList) && StrUtil.equals(ptList.get(0).get(1), "unknown")) {
                startPtIndex = 1;
            }
            if (ptList.size() > 2 + startPtIndex) {
                maxPt = ptList.get(startPtIndex).get(4) + "、" + ptList.get(startPtIndex + 1).get(4) + "和" + ptList.get(2 + startPtIndex).get(4) + "等";
            } else if (ptList.size() > 1 + startPtIndex) {
                maxPt = ptList.get(0).get(4) + "和" + ptList.get(1).get(4);
            } else if (ptList.size() == 1 + startPtIndex) {
                maxPt = ptList.get(0).get(4);
            }
            for (List<String> list : ptList) {
                String jpName = list.get(1);
                String name = list.get(4);
                String num = list.get(2);
                String percentage = list.get(3);
                //String diseaseType = list.get(4);
                JSONObject inner = new JSONObject();
                inner.put("jpName", jpName);
                inner.put("name", name);
                inner.put("num", num);
                inner.put("percentage", percentage);
                //inner.put("diseaseType", diseaseType);
                ptData.add(inner);
            }
        }
        result.getJSONObject("adverseReactionSignal").put("pt", ptData);
        if (StringUtils.isNotEmpty(maxPt)) {
            result.getJSONObject("adverseReactionSignal").put("ptExplain", "在" + dataName + "数据库上报的不良反应报告中，监测出不良反应共有" + ptNum + "个，其中最常见的有" + maxPt+"。");
        }
        // 2、典型信号分析 signal_dict i和i+o显示的效果不同
        //保存用于计算信号图i和o
        boolean flagPicture = true;
        List<JSONObject> pictureCondition = new ArrayList<>();


        if (drugs.size() > 0 && pts.size() > 0) {
            //i+o
            String s1 = null;
            Adrs adrs = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("description").in(pts.getJSONArray(0).getJSONObject(0).getString("trans")).and("type").is("drugname")), Adrs.class);
            Adrs adrs1 = mongoTemplate.findOne(new Query(Criteria.where("drugName").is(drugName).and("description").in(pts.getJSONArray(0).getJSONObject(0).getString("word")).and("type").is("drugname")), Adrs.class);
            String judge = "不属于";
            if (adrs != null || adrs1 != null) {
                String indicator = "";
                if (adrs != null) {
                    indicator = adrs.getIndicator();
                } else {
                    indicator = adrs1.getIndicator();
                }
                if ("+".equals(indicator)) {
                    judge = "属于";
                }
                JSONObject inner = new JSONObject();
                inner.put("i", condition.getDrugName());
                inner.put("o", condition.getPt());
                pictureCondition.add(inner);
            }
            s1 = ptNames + judge + drugName + "的典型信号。";
            result.getJSONObject("adverseReactionSignal").put("signalDictExplain", s1);
            Update update = new Update();
            update.set("prop1", s1);
            mongoTemplate.updateFirst(new Query(Criteria.where("_id").is(condition.getId())), update, "drug_adrs_search_data");
            if (type == 1) {
                searchAbstract.append("<span>" + s1 + "</span>");
            }

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
                    String[] split = key.split("[(（]");
                    String name = "";
                    try {
                        name = split[1].replaceAll("\\)|）", "").trim();
                        if (!GetMaxSimilarUtil.judgeChinese(name)) {
                            name = split[2].replaceAll("\\)", "").trim();
                        }
                    } catch (Exception e) {
                        log.error(e.toString());
                    }
                    for (List<String> list : value) {
                        numCount++;
                        JSONObject innerJson = new JSONObject();
                        String innerName = list.get(6);
                        String jpName = list.get(0);
                        String num = list.get(1);
                        String ror = list.get(3);
                        String ebgm = list.get(4);
                        String ic = list.get(5);
                        String rorPro = "("+list.get(7)+","+list.get(8)+")";
                        String icPro = "("+list.get(10)+","+list.get(9)+")";
                        ror = ror+rorPro;

                        innerJson.put("outEnglishName", split[0]);
                        innerJson.put("jpName", jpName);
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
                        innerJson.put("rorPro", rorPro);
                        innerJson.put("icPro", icPro);

                        //outName单纯英文显示
                        //String outEnglish = key.replaceAll("\\(|（.* " + name + " \\)|）", "").trim();
                        innerJson.put("outEnglish", split[0]);
                        if (ror.contains(".")) {
                            int rorIndex = ror.indexOf(".");
                            try {
                                innerJson.put("ror", ror);
                            } catch (Exception e) {
                                e.printStackTrace();
                                innerJson.put("ror", ror);
                            }
                        } else {
                            innerJson.put("ror", ror);
                        }
                        if (ebgm.contains(".")) {
                            int ebgmIndex = ebgm.indexOf(".");
                            try {
                                innerJson.put("ebgm", ebgm.substring(0, ebgmIndex + 2));
                            } catch (Exception e) {
                                e.printStackTrace();
                                innerJson.put("ebgm", ebgm);
                            }
                        } else {
                            innerJson.put("ebgm", ebgm);
                        }
                        if (ic.contains(".")) {
                            int icIndex = ic.indexOf(".");
                            try {
                                innerJson.put("ic", ic.substring(0, icIndex + 2)+icPro);
                            } catch (Exception e) {
                                e.printStackTrace();
                                innerJson.put("ic", ic);
                            }
                        } else {
                            innerJson.put("ic", ic);
                        }

                        //存放i+o
                        innerJson.put("i", condition != null ? condition.getDrugName() : "");
                        innerJson.put("o", condition != null ? condition.getPt() : new ArrayList<>());
                        //中文名
                        //innerJson.put("name", innerName);
                        signalDictData.add(innerJson);
                    }
                }
            }

            //按照ror排序并取前50
            if (!signalDictData.isEmpty()) {
                List<JSONObject> list = JSONArray.parseArray(JSONObject.toJSONString(signalDictData), JSONObject.class);
                try {

                    list.sort((o1, o2) -> {
                        double ror1 = Double.parseDouble(o1.getString("ror").substring(0, o1.getString("ror").indexOf("(")));
                        double ror2 = Double.parseDouble(o2.getString("ror").substring(0, o2.getString("ror").indexOf("(")));
                        return Double.compare(ror2, ror1);
                    });
                } catch (Exception e) {
                    e.printStackTrace();
                }
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
            try {
                result.getJSONObject("adverseReactionSignal").put("signalDictExplain", "在" + dataName + "数据库上报的不良反应报告中，监测出不良反应信号共有" + drugAlert.getDataTotal() + "个," + "其中最常见的有" +

                        signalDictData.getJSONObject(0).getString("name") + "," + signalDictData.getJSONObject(1).getString("name") + "和" + signalDictData.getJSONObject(2).getString("name") + "。");
            } catch (Exception e) {
                log.error("计算信号字典解释时异常", e);
            }

            result.getJSONObject("adverseReactionSignal").put("signalDictTypeCount", typeCount);
            result.getJSONObject("adverseReactionSignal").put("signalDictNumCount", numCount);
        }
        result.put("searchAbstract", searchAbstract);
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
                if ("未知".equals(max1)) {
                    max1 = outCodList.get(1).get(1);
                }
                for (List<String> list : outCodList) {
                    String name = list.get(1);
                    String num = list.get(2);
                    String percentage = list.get(3);
                    JSONObject inner = new JSONObject();
                    inner.put("name", name);
                    inner.put("num", num);
                    inner.put("percentage", percentage);
                    inner.put("marker", outcomeCod.get(name));
                    adverseReactions.add(inner);
                }
            }
        }
        result.getJSONObject("outcomeAnalysis").put("adverseReactions", adverseReactions);

        //处置
        JSONArray disposeOf = new JSONArray();
        List<List<String>> disposeOfList = drugAlert.getDisposeOf();
        String maxDisposeOf = "";
        if (CollUtil.isNotEmpty(disposeOfList)) {
            for (List<String> list : disposeOfList) {
                if (!"未知".equals(list.get(1))){
                    maxDisposeOf = disposeOfList.get(0).get(1);
                }else {
                    maxDisposeOf = disposeOfList.get(1).get(1);
                }
                String name = list.get(1);
                String num = list.get(2);
                String percentage = list.get(3);
                JSONObject inner = new JSONObject();
                inner.put("name", name);
                inner.put("num", num);
                inner.put("percentage", percentage);
                disposeOf.add(inner);
            }
        }
        result.getJSONObject("outcomeAnalysis").put("disposeOf", disposeOf);
        String disposeOfAndadverseReactions = "在" + dataName + "数据库上报的不良反应报告中，除未知数据外，";
        if (StringUtils.isNotEmpty(max1) || StringUtils.isNotEmpty(maxDisposeOf)) {
            if (StringUtils.isNotEmpty(maxDisposeOf)) {
                disposeOfAndadverseReactions = disposeOfAndadverseReactions + "处置方式最多的为" + maxDisposeOf + "，";
            }
            if (StringUtils.isNotEmpty(max1)) {
                disposeOfAndadverseReactions = disposeOfAndadverseReactions + "转归最多的为" + max1 + "，";
            }
            disposeOfAndadverseReactions = disposeOfAndadverseReactions.substring(0, disposeOfAndadverseReactions.length() - 1);


        }


        result.getJSONObject("outcomeAnalysis").put("disposeOfAndadverseReactions", disposeOfAndadverseReactions + "。");

        //计算严重不良反应占比 严重 非严重
        Map<String, Integer> outCodCount = drugAlert.getOutCCodCount();
        if (CollUtil.isNotEmpty(outCodCount)) {
            Integer adverseNum = outCodCount.get("yes");
            Integer nonAdverseNum = outCodCount.get("no");
            int totalNum = adverseNum + nonAdverseNum;
            if (totalNum > 0) {
                JSONArray adversePercentage = new JSONArray();
                JSONObject innerAdverse1 = new JSONObject();
                BigDecimal nonAdversePercentage = BigDecimal.valueOf(100)
                        .subtract(BigDecimal.valueOf(nonAdverseNum).divide(BigDecimal.valueOf(totalNum), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)))
                        .setScale(2, RoundingMode.HALF_UP); // 保留两位小数
                DecimalFormat decimalFormat = new DecimalFormat("0.00");
                String formattedValue = decimalFormat.format(nonAdversePercentage);
                double doubleValue1 = nonAdversePercentage.doubleValue();
                innerAdverse1.put("name", "严重不良反应");
                innerAdverse1.put("num", adverseNum);
                innerAdverse1.put("percentage", doubleValue1 + "%");
                adversePercentage.add(innerAdverse1);
                JSONObject innerAdverse2 = new JSONObject();
                innerAdverse2.put("name", "非严重不良反应");
                innerAdverse2.put("num", nonAdverseNum);
                String formattedValue1 = decimalFormat.format(100 - doubleValue1);
                innerAdverse2.put("percentage", formattedValue1 + "%");
                adversePercentage.add(innerAdverse2);
                result.getJSONObject("outcomeAnalysis").put("adversePercentage", adversePercentage);
                if (StringUtils.isNotEmpty(max1)) {
                    StringBuilder inner = new StringBuilder();
                    inner.append("在").append(dataName).append("数据库上报的不良反应报告中，严重不良反应占比为").append(formattedValue).append("%，其中").append(max1).append("占比最高");
                    if (StringUtils.isNotEmpty(max2)) {
                        inner.append("，其次是").append(max2);
                    }
                    inner.append("。");
                    result.getJSONObject("outcomeAnalysis").put("adverseExplain", inner.toString());
                }
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
            //todo
            for (List<String> list : dechal) {
                String name = list.get(1);
                String num = list.get(2);
                String percentage = list.get(3);
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
            //todo
            for (List<String> list : rechal) {
                String name = list.get(1);
                String num = list.get(2);
                String percentage = list.get(3);
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
            inner.append("在").append(dataName).append("数据库上报的不良反应报告中");
            inner.append(dechalExplain);
            if (StringUtils.isNotEmpty(rechalExplain)) {
                inner.append(rechalExplain);
            }
            inner.append("。");
            // 修复StringBuilder不能被MongoDB序列化的问题，确保转换为String类型
            result.getJSONObject("outcomeAnalysis").put("dechalAndRechalExplain", inner.toString());
        }

        JSONObject object = new JSONObject();
        // 修复StringBuilder不能被MongoDB序列化的问题，确保将整个result对象转换为JSON字符串
        // object.put("result", result.toJSONString());
        // object.put("_id", condition.getId());
        // //mongo存储一份数据
        // mongoTemplate.insert(object, "fears_data");
        return result;
    }


    @Override
    public Boolean upload(FileInfoUploadDto fileInfoUploadDto) {
        SysUser sysUser = this.userService.getCurrentUser();
        ReleaseData releaseData = new ReleaseData();
        releaseData.setId(UUID.randomUUID().toString());
        //报告名称
        String fileName = fileInfoUploadDto.getFileName();
        MultipartFile file = fileInfoUploadDto.getFile();
        String name = file.getOriginalFilename();
        if (StringUtils.isNotBlank(fileName)) {
            releaseData.setName(fileName);
        } else {
            releaseData.setName(name);
        }
        if (StringUtils.isNotBlank(name)) {
            if (name.contains("治疗") && name.contains("临床综合评价报告")) {
                //药品名称
                String drugName;
                //疾病名称
                String disease;
                int indexOf1 = name.indexOf("治疗");
                int indexOf2 = name.indexOf("临床综合评价报告");
                drugName = name.substring(0, indexOf1);
                String str = name.substring(0, indexOf2);
                disease = str.replaceAll("治疗", "").replaceAll(drugName, "");
                releaseData.setDrugName(drugName);
                releaseData.setDisease(disease);
            } else {
                releaseData.setDrugName("");
                releaseData.setDisease("");
            }
        } else {
            releaseData.setDrugName("");
            releaseData.setDisease("");
        }
        releaseData.setDrugName(fileInfoUploadDto.getDrugName());
        releaseData.setDrugName(fileInfoUploadDto.getPtName());
        //发布作者的唯一id
        releaseData.setUserId(sysUser.getUserId());
        //发布作者
        releaseData.setAuthor(StringUtils.isBlank(fileInfoUploadDto.getAuthor()) ? sysUser.getUserName() : fileInfoUploadDto.getAuthor());
        //发布单位
        releaseData.setWorkUnit(StringUtils.isBlank(fileInfoUploadDto.getWorkUnit()) ? "" : fileInfoUploadDto.getWorkUnit());
        //发布科室
        releaseData.setDepartment(StringUtils.isBlank(fileInfoUploadDto.getDepartment()) ? "" : fileInfoUploadDto.getDepartment());
        //发布时间
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
        releaseData.setTime(format.format(new Date()));
        //文件所在位置
        InputStream inputStream = null;
        try {
            inputStream = file.getInputStream();
        } catch (IOException e) {
            log.error(e.getMessage(), e);
        }
        String[] strings = FastDFSClient.uploadFile(inputStream, name);
        if (strings != null) {
            String filePath = strings[1];
            log.info("文件[{}]上传从成功，上传地址为[{}]", name, filePath);
            releaseData.setFilePath(filePath);
            this.releaseMongoUtil.mongo.insert(releaseData);
            return true;
        }
        return false;
    }

    @Override
    public Page<ReleaseVO> listPub(String words, Integer pageNum, Integer pageSize) {
        Query query = new Query();
        SysUser sysUser = this.userService.getCurrentUser();
        if (StrUtil.isNotBlank(words)) {
            query = new Query(Criteria.where("name").regex("(?i)" + words));
        }
        long total = this.releaseMongoUtil.mongo.count(query, ReleaseData.class);
        query.with(PageRequest.of(pageNum - 1, pageSize));
        query.with(Sort.by(Sort.Direction.DESC, "time"));
        List<ReleaseVO> list = this.releaseMongoUtil.mongo.find(query, ReleaseVO.class);
        for (ReleaseVO vo : list) {
            Query collectQuery = new Query(Criteria.where("userId").is(sysUser.getUserId()).and("pubId").is(vo.getId()));
            vo.setCollect(this.mongoTemplate.exists(collectQuery, JSONObject.class, "drug_safe_pub_collect") ? 1 : 0);
        }
        return new Page<>(list, total, pageSize, pageNum);
    }

    @Override
    public void collectPub(String pubId, boolean status) {
        SysUser sysUser = this.userService.getCurrentUser();
        JSONObject jsonObject = new JSONObject();
        Query query = new Query(Criteria.where("userId").is(sysUser.getUserId()).and("pubId").is(pubId));
        if (status) {
            this.mongoTemplate.remove(query, "drug_safe_pub_collect");
            jsonObject.put("userId", sysUser.getUserId());
            jsonObject.put("pubId", pubId);
            this.mongoTemplate.insert(jsonObject, "drug_safe_pub_collect");
        } else {
            this.mongoTemplate.remove(query, "drug_safe_pub_collect");
        }
    }

    @Override
    public void adrs(String s) {

        adrsAdd(s);

    }

    @Override
    public void instructions() {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_TEST_DATA")));
        MongoTemplate dataMongoTemplatex = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_EVIMED_NEW")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), "instructions_deduplicated");
        long page = instructionsCleaning / 1000 + 1;
        for (int i = 0; i < page; i++) {
            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip(i * 1000).limit(1000), JSONObject.class, "instructions_deduplicated");
            dataMongoTemplatex.insert(instructionsCleaning1, "adrs");
            System.out.println("加载了条数：" + (i + 1) * 1000);

        }
        System.out.println("加载完成");
    }


    private static final Map<String, String> outcomeCod = new HashMap<>();

    static {
        outcomeCod.put("其他严重 (重大医疗事件)", "OT");
        outcomeCod.put("死亡", "DE");
        outcomeCod.put("住院初次或长期", "HC");
        outcomeCod.put("危及生命", "LT");
        outcomeCod.put("残疾", "DS");
        outcomeCod.put("先天性异常或出生缺陷", "CA");
        outcomeCod.put("永久的损伤/伤害", "RI");


    }


    @Async
    protected void adrsAdd(String s) {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_TEST_DATA")));
        MongoTemplate dataMongoTemplatex = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_EVIMED_NEW")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), "adrs");
        long page = instructionsCleaning - Long.parseLong(s) / 1000 + 1;
        for (int i = 0; i < page; i++) {
            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip(Long.parseLong(s) + i * 1000).limit(1000), JSONObject.class, "adrs");
            dataMongoTemplatex.insert(instructionsCleaning1, "adrs");
            if (i % 100 == 0) {
                System.out.println("加载了条数：" + (i + 1) * 1000);
            }

        }
        System.out.println("加载完成");
    }
}
