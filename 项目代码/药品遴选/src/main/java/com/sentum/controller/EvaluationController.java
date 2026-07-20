package com.sentum.controller;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.lowagie.text.DocumentException;
import com.sentum.infrastructure.config.ThreadPoolConfig;
import com.sentum.enums.MongoTableNameEnum;
import com.sentum.feign.MedicineFeign;
import com.sentum.pojo.dto.*;
import com.sentum.pojo.vo.ConditionVo;
import com.sentum.pojo.vo.DataResult;
import com.sentum.pojo.vo.SynonymVo;
import com.sentum.service.EvaluationService;
import com.sentum.service.impl.LxGptServiceImpl;
import com.sentum.util.RedisUtil;
import com.sentum.util.SecurityUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;


@Slf4j
@Api(tags = "快速综合评价API")
@RestController
@RequestMapping("/evaluation-api")
public class EvaluationController {

    private static String requiredMongoUri(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException(name + " must be provided by the runtime secret store");
        }
        return value.trim();
    }
    
    @Autowired
    private EvaluationService evaluationService;
    @Autowired
    private LxGptServiceImpl lxGptService;
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private MedicineFeign medicineFeign;

    @Qualifier(ThreadPoolConfig.MAIN_GPTANALYSIS_THREAD_POOL_NAME)
    @Autowired
    ThreadPoolTaskExecutor gptAnalysisThreadPool;
    
    @ApiOperation(value = "指南线上看板数据word版本下载", notes = "guide-download-word")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/traditional/guide-download-word-v2")
    public void guideDownloadWordV2(String id, HttpServletResponse response) {
        try {
            evaluationService.generateReport(response,id);
        } catch (IOException | DocumentException e) {
            log.error("中成药综合评价报告word版本下载异常 {}", e.getMessage(), e);
        }
    }

    @ApiOperation(value = "指南线上看板数据word版本下载", notes = "guide-download-word")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/guide-download-word")
    public void guideDownloadWord(String id, HttpServletResponse response) {
        try {
            evaluationService.guideDownloadWord(id, response);
        } catch (IOException | DocumentException e) {
            log.error("西药综合评价报告word版本下载异常");
        }
    }
    
    
    
    
    
    
    
    
    
    
    
    

    @ApiOperation(value = "联想词", notes = "getAssociationalWord")
    @ApiImplicitParam(name = "word", value = "用户输入框输入词", required = true)
    @GetMapping("/get-associational-word")
    public DataResult getAssociationalWord(String word) {
        return DataResult.data(evaluationService.getAssociationalWord(word));
    }

    @ApiOperation(value = "查询当前词的同义词及其翻译", notes = "get-synonym")
    @ApiImplicitParam(name = "word", value = "用户输入条件", required = true)
    @GetMapping("/get-synonym")
    public DataResult getSynonym(String word, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
            ConditionVo synonym = evaluationService.getSynonym(word, userId);
            return DataResult.data(synonym);
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }

//        // 使用 CompletableFuture 实现超时控制
//        try {
//            CompletableFuture<Object> future = CompletableFuture.supplyAsync(() ->
//                    evaluationService.getSynonym(word, userId)
//            );
//
//            // 设置10秒超时
//            Object result = future.get(10, TimeUnit.SECONDS);
//            return DataResult.data(result);
//        } catch (Exception e) {
//            // 超时或执行异常时返回错误
//            return DataResult.error(504, "请求超时，请稍后重试");
//        }
    }

    @ApiOperation(value = "查询药品分类", notes = "get-category")
    @GetMapping("/get-category")
    public DataResult getCategory(String type) {
        return DataResult.data(evaluationService.getCategory(type));
    }


    /**
     * @param synonym 同义词接收实体类
     */
    @ApiOperation(value = "存储页面存储的同义词", notes = "save-synonym")
    @PostMapping("/save-synonym")
    public DataResult saveSynonym(@RequestBody List<SynonymVo> synonym, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        evaluationService.saveSynonym(synonym, userId);
        return DataResult.ok();
    }

    @ApiOperation(value = "用户检索历史记录", notes = "history")
    @GetMapping("/history")
    public DataResult history(HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(evaluationService.history(userId));
    }

    @ApiOperation(value = "将当前id的历史记录进行置顶操作/取消置顶", notes = "top")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "historyId", value = "历史记录的id", required = true),
            @ApiImplicitParam(name = "status", value = "操作状态，置顶1，取消置顶2", required = true)
    })
    @GetMapping("/top")
    public DataResult top(String historyId, Integer status) {
        Integer top = evaluationService.top(historyId, status);
        if (top == 0) {
            return DataResult.error("当前历史记录id不存在");
        } else if (top == 1) {
            return DataResult.data(true);
        } else {
            return DataResult.data(false);
        }
    }

    @ApiOperation(value = "根据历史记录id删除当前检索历史记录", notes = "delete-history")
    @ApiImplicitParam(name = "historyId", value = "历史记录的id", required = true)
    @GetMapping("/delete-history")
    public DataResult deleteHistory(String historyId,String isAll ,HttpServletRequest request, HttpServletResponse response) {

        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }


        return DataResult.data(evaluationService.deleteHistory(historyId, isAll, userId));
    }

    @ApiOperation(value = "通过用户操作的条件进行疾病信息的检索", notes = "disease")
    @PostMapping("/disease")
    public DataResult disease(@RequestBody ConditionVo conditionVo) {
        return DataResult.data(evaluationService.disease(conditionVo));
    }

    @ApiOperation(value = "通过用户操作的条件进行药品适应症信息的检索", notes = "drugAndIndication")
    @PostMapping("/drug-indication")
    public DataResult drugAndIndication(@RequestBody ConditionVo conditionVo) {
        return DataResult.data(evaluationService.drugAndIndication(conditionVo));
    }

    @ApiOperation(value = "判断用户操作之后是否需要跳转到参比药物页面，code=200时使用返回值请求分析接口，status=1药品数量大于1，status=2疾病数量大于1；code等于201时请求参比药物接口", notes = "judge")
    @PostMapping("/judge")
    public DataResult judge(@RequestBody DrugAndDiseaseDto drugAndDiseaseDto) {
        JSONObject judge = evaluationService.judge(drugAndDiseaseDto);
        Integer status = judge.getInteger("status");
        if (status == 1) {
            return DataResult.data(judge.getJSONArray("data"));
        } else {
            return DataResult.error(201, "");
        }
    }

    @ApiOperation(value = "参比药物列表", notes = "drug-price")
    @PostMapping("/drug-price")
    public DataResult drugAndPrice(@RequestBody ReferenceDrugDto referenceDrugDto) {
        return DataResult.data(evaluationService.drugAndPrice(referenceDrugDto));
    }



    @ApiOperation(value = "参比药物列表", notes = "drug-price")
    @PostMapping("/drug-price-all")
    public DataResult drugAndPriceAll(@RequestBody ReferenceDrugAllDto referenceDrugDto) {
        return DataResult.data(evaluationService.drugAndPriceAll(referenceDrugDto));
    }

    @ApiOperation(value = "保存用户输入的药品价格数据", notes = "save-drug-price")
    @PostMapping("/save-drug-price")
    public DataResult saveDrugPrice(@RequestBody SaveDrugPriceDto saveDrugPriceDto) {
        String saveDrugPrice = evaluationService.saveDrugPrice(saveDrugPriceDto);
        if ("-1".equals(saveDrugPrice)) {
            return DataResult.error("价格表存储失败");
        }
        return DataResult.data(saveDrugPrice);
    }

    @ApiOperation(value = "苏大一线上看板数据", notes = "su-online")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/su-online")
    public DataResult suOnline(String id) {
        return DataResult.data(evaluationService.suOnline(id));
    }

    @ApiOperation(value = "指南线上看板数据", notes = "guide-online")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/guide-online")
    public DataResult guideOnline(String id) {
        return DataResult.data(evaluationService.guideOnline(id));
    }

    @ApiOperation(value = "指南分析结果的检索 pharmacyScore-药学特性;effectivenessScore-有效性得分;safetyScore-安全性得分;economyScore-经济性;otherAttributesScore-其他属性", notes = "su-on-analysis")
    @GetMapping("/guide-on-analysis")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "drugName", value = "药品名称", required = true),
            @ApiImplicitParam(name = "disease", value = "疾病名称", required = true),
            @ApiImplicitParam(name = "specifications", value = "规格", required = false),
            @ApiImplicitParam(name = "id", value = "前端自定义id", required = true),
            @ApiImplicitParam(name = "priceId", value = "priceId", required = true),
            @ApiImplicitParam(name = "drugId", value = "药品id", required = true),
            @ApiImplicitParam(name = "searchId", value = "检索流程id", required = true),
            @ApiImplicitParam(name = "isCustom", value = "是否是自定义疾病，0false，1true", required = true, paramType = "query")
    })
    public DataResult guideOnAnalysis(String drugName, String disease, String specifications, String id, String priceId, String drugId, String searchId, String isCustom, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(evaluationService.guideOnAnalysis(drugName, disease, specifications, id, priceId, userId, isCustom, drugId, searchId));
    }



//
//    @ApiOperation(value = "苏大一分析结果的检索 safetyScore-安全性得分;effectivenessScore-有效性得分;suitabilityScore-适宜性得分", notes = "su-on-analysis")
//    @GetMapping("/su-on-analysis")
//    @ApiImplicitParams({
//            @ApiImplicitParam(name = "drugName", value = "药品名称", required = true),
//            @ApiImplicitParam(name = "disease", value = "疾病名称", required = true),
//            @ApiImplicitParam(name = "id", value = "前端自定义id", required = true),
//            @ApiImplicitParam(name = "priceId", value = "priceId", required = true),
//            @ApiImplicitParam(name = "priceId", value = "priceId", required = true),
//            @ApiImplicitParam(name = "drugId", value = "药品id", required = true),
//            @ApiImplicitParam(name = "specifications", value = "规格", required = false),
//            @ApiImplicitParam(name = "isCustom", value = "是否是自定义疾病，0false，1true", required = true, paramType = "query")
//
//    })
//    public DataResult suOnAnalysis(String drugName, String disease, String id, String priceId, String drugId, String searchId, String specifications, String isCustom, HttpServletRequest request, HttpServletResponse response) {
//        long userId;
//        try {
//            String token = request.getHeader("token");
//            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
//            assert redis != null;
//            JSONObject redisMap = JSONObject.parseObject(redis.toString());
//            userId = Long.parseLong(redisMap.get("userId").toString());
//        } catch (Exception e) {
//            response.setStatus(401);
//            return DataResult.error(401, "token can't null or empty string");
//        }
//        return DataResult.data(evaluationService.suOnAnalysis(drugName, disease, id, priceId, specifications, isCustom, userId, drugId, searchId));
//    }

//    @ApiOperation(value = "苏大一分析结果的检索 safetyScore-安全性得分;effectivenessScore-有效性得分;suitabilityScore-适宜性得分", notes = "su-on-analysis")
//    @GetMapping("/su-on-analysis-app")
//    @ApiImplicitParams({
//            @ApiImplicitParam(name = "drugName", value = "药品名称", required = true),
//            @ApiImplicitParam(name = "disease", value = "疾病名称", required = true),
//            @ApiImplicitParam(name = "id", value = "前端自定义id", required = true),
//            @ApiImplicitParam(name = "priceId", value = "priceId", required = true),
//            @ApiImplicitParam(name = "specifications", value = "规格", required = false),
//            @ApiImplicitParam(name = "isCustom", value = "是否是自定义疾病，0false，1true", required = true, paramType = "query")
//    })
//    public DataResult suOnAnalysisApp(String drugName, String disease, String id, String priceId, String specifications, String isCustom, HttpServletRequest request, HttpServletResponse response) {
//        long userId;
//        try {
//            String token = request.getHeader("token");
//            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
//            assert redis != null;
//            JSONObject redisMap = JSONObject.parseObject(redis.toString());
//            userId = Long.parseLong(redisMap.get("userId").toString());
//        } catch (Exception e) {
//            response.setStatus(401);
//            return DataResult.error(401, "token can't null or empty string");
//        }
//        return DataResult.data(evaluationService.suOnAnalysisApp(drugName, disease, id, priceId, specifications, isCustom, userId));
//    }

    @ApiOperation(value = "指南分析结果的检索 pharmacyScore-药学特性;effectivenessScore-有效性得分;safetyScore-安全性得分;economyScore-经济性;otherAttributesScore-其他属性", notes = "su-on-analysis")
    @GetMapping("/guide-on-analysis-app")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "drugName", value = "药品名称", required = true),
            @ApiImplicitParam(name = "disease", value = "疾病名称", required = true),
            @ApiImplicitParam(name = "specifications", value = "规格", required = false),
            @ApiImplicitParam(name = "id", value = "前端自定义id", required = true),
            @ApiImplicitParam(name = "priceId", value = "priceId", required = true),
            @ApiImplicitParam(name = "isCustom", value = "是否是自定义疾病，0false，1true", required = true, paramType = "query")
    })
    public DataResult guideOnAnalysisApp(String drugName, String disease, String specifications, String id, String priceId, String isCustom, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(evaluationService.guideOnAnalysisApp(drugName, disease, specifications, id, priceId, userId, isCustom));

    }


      @ApiOperation(value = "指南分析结果的检索 pharmacyScore-药学特性;effectivenessScore-有效性得分;safetyScore-安全性得分;economyScore-经济性;otherAttributesScore-其他属性", notes = "su-on-analysis")
    @PostMapping("/guide-app-asynchronous")
    public DataResult guideAppAsynchronous(@RequestBody AsynchronousVo asynchronousVo ,HttpServletRequest request, HttpServletResponse response) {
        long userId;
        String token  = "";
        try {
             token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
          List<Asynchronous> asynchronousList = asynchronousVo.getAsynchronousList();
          String idx = SecurityUtil.getMd5(UUID.randomUUID().toString());
          if (asynchronousList.size()>1){
              JSONObject secretKey = medicineFeign.createSecretKey(token, idx, "");
          }
          String finalToken1 = token;
          CompletableFuture<Void> total = CompletableFuture.runAsync(() -> {
              Date startDate = new Date();
              final String  finalToken = finalToken1;
              String ids = "";
              boolean isTr = true;
              for (Asynchronous asynchronous : asynchronousList) {
                  String id = SecurityUtil.getMd5(asynchronous.getDrugId() + UUID.randomUUID().toString());

                  if (StringUtils.isNotEmpty(asynchronous.getDisease())) {
                      isTr = false;

                          JSONObject secretKey1 = medicineFeign.createSecretKey(finalToken, id,"");
                          log.info("secretKey1:"+secretKey1);
                          evaluationService.guideAppAsynchronous(
                                  asynchronous.getDrugName(),
                                  asynchronous.getDisease(),
                                  asynchronous.getDrugSpecifications(),
                                  id,
                                  asynchronous.getPriceId(),
                                  userId,
                                  asynchronous.getIsCustom(),
                                  request,
                                  finalToken,
                                          (asynchronousList.size()==1)
                          );

                      ids = ids + id + ",";
                      isTr = false;

                  }else {

                          JSONObject secretKey1 = medicineFeign.createSecretKey(finalToken, id,"");
                          log.info("secretKey1:"+secretKey1);
                          evaluationService.guideAppAsynchronousTr(
                                  asynchronous.getDrugName(),
                                  asynchronous.getDisease(),
                                  id,
                                  asynchronous.getPriceId(),
                                  userId,
                                  asynchronous.getDrugId(),
                                  null,
                                  finalToken,
                                          (asynchronousList.size()==1)
                          );

                      ids = ids + id + ",";
                  }

              }
              ids = ids.substring(0,ids.length()-1);

              if (asynchronousList.size()>1){
              evaluationService.guideAppAsynchronousx(
                      idx,
                      userId,
                      request,
                      finalToken,
                      ids,
                      startDate,
                      isTr

              );}

          }, gptAnalysisThreadPool);

          // 使用 whenComplete 处理任务完成后的逻辑
          total.whenComplete((result, exception) -> {
              if (exception != null) {
                  exception.printStackTrace();
                  // 可以在这里记录日志或进行其他处理
              } else {
                  // 任务成功完成后的逻辑
                  System.out.println("All tasks completed successfully.");
              }
          });


        return DataResult.ok();

    }

    


    @ApiOperation(value = "指南线上看板数据pdf版本下载", notes = "guide-download-word")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/guide-download-pdf")
    public void guideDownloadPdf(String id, HttpServletResponse response) {
        try {
            evaluationService.guideDownloadPdf(id, response);
        } catch (IOException | DocumentException e) {
            log.error("指南综合评价报告word版本下载异常");
            e.printStackTrace();
        }
    }


    


    @ApiOperation(value = "指南线上看板数据word版本下载", notes = "guide-download-word")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/traditional/guide-download-pdf")
    public void guideDownloadWordV2Pdf(String id, HttpServletResponse response) {
        try {
            evaluationService.guideDownloadV2Pdf(id, response);
        } catch (IOException | DocumentException e) {
            log.error("指南综合评价报告word版本下载异常");
            e.printStackTrace();
        }
    }

    @ApiOperation(value = "指南线上看板数据word版本下载", notes = "guide-download-word")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/guide-download-words")
    public void guideDownloadWords(String id, HttpServletResponse response) {
        try {
            evaluationService.guideDownloadWords(id, response);
        } catch (IOException | DocumentException e) {
            log.error("指南综合评价报告word版本下载异常");
            e.printStackTrace();
        }
    }

    @ApiOperation(value = "苏大一线上看板数据word版本下载", notes = "su-download-word")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/traditional/download-word")
    public void suDownloadWord(String id, HttpServletResponse response) {
        try {
            evaluationService.generateLianhuaQingwenReport( response,id);
        } catch (IOException | DocumentException e) {
            log.error("综合评价报告word版本下载异常");
            e.printStackTrace();
        }
    }

    @ApiOperation(value = "苏大一线上看板数据word版本下载", notes = "su-download-word")
    @ApiImplicitParam(name = "ids", value = "当前检索条件的id", required = true)
    @GetMapping("/traditional/download-words")
    public void suDownloadWords(String ids, HttpServletResponse response) {
        try {
            evaluationService.generateLianhuaQingwenReports( response,ids);
        } catch (IOException | DocumentException e) {
            log.error("综合评价报告word版本下载异常");
            e.printStackTrace();
        }
    }



    @ApiOperation(value = "苏大一线上看板数据excel版本下载", notes = "su-download-excel")
    @ApiImplicitParam(name = "id", value = "当前检索条件的id", required = true)
    @GetMapping("/su-download-excel")
    public void suDownloadExcel(String id, HttpServletResponse response) {
        try {
            evaluationService.suDownloadExcel(id, response);
        } catch (IOException e) {
            log.error("苏大一综合评价报告excel版本下载异常");
            e.printStackTrace();
        }
    }

    @ApiOperation(value = "用户补充说明书", notes = "drug-add")
    @PostMapping("/drug-add")
    public DataResult drugAdd(@RequestBody DrugAddDto drugAdd, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(evaluationService.drugAdd(drugAdd, userId));
    }

    @ApiOperation(value = "现有说明书回显", notes = "drug-data")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "searchId", value = "流程id", required = true),
            @ApiImplicitParam(name = "drugId", value = "药品id", required = true)
    })
    @GetMapping("/drug-data")
    public DataResult drugData(String searchId, String drugId) {
        return DataResult.data(evaluationService.drugData(searchId, drugId));
    }

    @ApiOperation(value = "将说明书的url转化为base64格式，返回值可能为空，当返回值为空字符串时不进行跳转", notes = "url-to-base64")
    @ApiImplicitParam(name = "url", value = "说明书路径", required = true)
    @GetMapping("/url-to-base64")
    public DataResult urlToBase64(String url) {
        return DataResult.data(evaluationService.urlToBase64(url));
    }


    @ApiOperation(value = "获取说明书信息", notes = "drug-lines")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "disease", value = "疾病名称，多个药品时，使用英文分号隔开", required = true),
            @ApiImplicitParam(name = "searchId", value = "流程id", required = true),
            @ApiImplicitParam(name = "drugIds", value = "药品id,多个药品时，使用英文逗号隔开", required = true)
    })
    @GetMapping("/drug-lines")
    public DataResult drugLines(String disease, String searchId, String drugIds) {
        return DataResult.data(evaluationService.getlines(disease, searchId, drugIds));
    }


    @ApiOperation(value = "获取说明书信息", notes = "drug-lines-sdy")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "disease", value = "疾病名称，多个药品时，使用英文分号隔开", required = true),
            @ApiImplicitParam(name = "searchId", value = "流程id", required = true),
            @ApiImplicitParam(name = "drugIds", value = "药品id,多个药品时，使用英文逗号隔开", required = true)
    })
    @GetMapping("/drug-lines-sdy")
    public DataResult drugLineSdy(String disease, String searchId, String drugIds) {
        return DataResult.data(evaluationService.getlinesSdy(disease, searchId, drugIds));
    }


    @ApiOperation(value = "获取说明书信息", notes = "drug-other")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "disease", value = "疾病名称，多个药品时，使用英文分号隔开", required = true),
            @ApiImplicitParam(name = "searchId", value = "流程id", required = true),
            @ApiImplicitParam(name = "drugIds", value = "药品id,多个药品时，使用英文逗号隔开", required = true)
    })
    @GetMapping("/drug-other")
    public DataResult drugOther(String disease, String searchId, String drugIds) {
        return DataResult.data(evaluationService.getOther(disease, searchId, drugIds));
    }



    @ApiOperation(value = "获取说明书信息", notes = "drug-data-info")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "disease", value = "疾病名称", required = true),
            @ApiImplicitParam(name = "searchId", value = "流程id", required = true),
            @ApiImplicitParam(name = "drugIds", value = "药品id,多个药品时，使用英文逗号隔开", required = true)
    })
    @GetMapping("/drug-data-info")
    public DataResult drugDataInfo(String disease, String searchId, String drugIds) {
        return DataResult.data(evaluationService.drugDataInfo(disease, searchId, drugIds));
    }

    @ApiOperation(value = "获取说明书信息", notes = "drug-data-info")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "disease", value = "疾病名称", required = true),
            @ApiImplicitParam(name = "searchId", value = "流程id", required = true),
            @ApiImplicitParam(name = "drugIds", value = "药品id,多个药品时，使用英文逗号隔开", required = true)
    })
    @GetMapping("/drug-data-tal")
    public DataResult drugDataTal(String disease, String searchId, String drugIds) {
        return DataResult.data(evaluationService.getDataTalPuls(disease, searchId, drugIds));
    }


    @ApiOperation(value = "获取说明书信息", notes = "drug-data-sdy")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "disease", value = "药品名称", required = true),
            @ApiImplicitParam(name = "searchId", value = "流程id", required = true),
            @ApiImplicitParam(name = "drugIds", value = "药品id,多个药品时，使用英文逗号隔开", required = true)
    })
    @GetMapping("/drug-data-sdy")
    public DataResult drugDataSdy(String disease, String searchId, String drugIds) {
        return DataResult.data(evaluationService.drugDataSdy(disease, searchId, drugIds));
    }

    @ApiOperation(value = "获取说明书信息", notes = "drug-sdy-tal")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "disease", value = "药品名称", required = true),
            @ApiImplicitParam(name = "searchId", value = "流程id", required = true),
            @ApiImplicitParam(name = "drugIds", value = "药品id,多个药品时，使用英文逗号隔开", required = true)
    })
    @GetMapping("/drug-sdy-tal")
    public DataResult drugSdyTal(String disease, String searchId, String drugIds) {
        return DataResult.data(evaluationService.drugSdyTalPlus(disease, searchId, drugIds));
    }

    @ApiOperation(value = "获取说明书信息", notes = "gpt")
    @PostMapping("/gpt")
    public DataResult drugDataSdy(@RequestBody JSONObject jsonObject) {
        String prompt = jsonObject.getString("prompt");
        return DataResult.data(lxGptService.getGpt(prompt, jsonObject.getString("model"),""));
    }


    @ApiOperation(value = "数据储存", notes = "data-save-sdy")
    @PostMapping("/data-save-sdy")
    public DataResult dataSaveSdy(@RequestBody JSONObject jsonObject) {
        log.info(jsonObject.toString());
        mongoTemplate.save(jsonObject, "drug_data_sdy");
        return DataResult.ok();
    }

    @ApiOperation(value = "数据储存", notes = "data-save")
    @PostMapping("/data-save")
    public DataResult dataSave(@RequestBody JSONObject jsonObject) {
        mongoTemplate.save(jsonObject, "drug_data");
        log.info(jsonObject.toString());
        return DataResult.ok();
    }


    //=================================数据处理逻辑===========================================
    @GetMapping("/insertGradeAndDrugsTable")
    public void insertGradeAndDrugsTable() {
        evaluationService.insertGradeAndDrugsTable();
    }

    @GetMapping("/insertToIndex")
    public void insertToIndex() {
        evaluationService.insertToIndex();
    }

    @GetMapping("/insertDrugPrice")
    public void insertDrugPrice() {
        evaluationService.insertDrugPrice();
    }

    @GetMapping("/changeDrugIndicationDataForm")
    public void changeDrugIndicationDataForm() {
        evaluationService.changeDrugIndicationDataForm();
    }


    @GetMapping("/test")
    public void test() {
        JSONObject jsonObject = lxGptService.guideWenEnterprise("北京圣永制药有限公司");
        System.out.println(jsonObject);
    }

    @GetMapping("/handleDrugInfo")
    public void handleDrugInfo() {
        evaluationService.handleDrugInfo();
    }


    @GetMapping("/importDrugInfo")
    public void importDrugInfo() {
        evaluationService.importDrugInfo();
    }



    @GetMapping("/getInstructionsDeduplicated")
    @ApiImplicitParam(name = "hasData", value = "已添加数据的数量")
    public void getInstructionsDeduplicated(Long hasData) {
        evaluationService.getInstructionsDeduplicated(hasData);
    }

    @GetMapping("/insUpdate")
    public void updateIns(String id) {
        evaluationService.insUpdate(id);
    }

    @GetMapping("/addMongo/{table}")
    public void instructions_cleaning(@PathVariable("table") String table, String tableName, Integer x, Boolean haveEs) {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_INSTRUCTIONS_DATA")));
        MongoTemplate dataMongoTemplatex = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_EVIMED_NEW")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), table);
        long page = (instructionsCleaning - x) / 1000 + 1;
        for (int i = 0; i < page; i++) {
            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip(i * 1000 + x).limit(1000), JSONObject.class, table);
            for (JSONObject doc : instructionsCleaning1) {

                if (doc.containsKey("approveCodeNMPA")) {
                    doc.put("approveCode", doc.get("approveCodeNMPA"));
                    doc.remove("approveCodeNMPA");
                }
                try {
                    dataMongoTemplatex.insert(doc, tableName);
                } catch (Exception e) {
                    log.error(doc.toString());
                }

            }

            System.out.println("加载了条数：" + (i + 1) * 1000);
        }
        System.out.println("加载完成");
    }


    @GetMapping("/filter")
    public Map<Object,Object> filter(String word) {

        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_EVIMED_NEW")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), word);
        long page = instructionsCleaning / 1000 + 1;
        HashMap<Object, Object> objectObjectHashMap = new HashMap<>();
        HashSet<String> strings = new HashSet<>();
        for (int i = 0; i < page; i++) {
            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip(i * 1000 ).limit(1000), JSONObject.class, word);
            for (JSONObject doc : instructionsCleaning1){
                JSONArray entryTerms = doc.getJSONArray("entryTerms");

                for (String entryTerm :  entryTerms.toJavaList(String.class)) {
                    if (entryTerm.length()<=2){
                        String regex = "[\\u4e00-\\u9fa5]";
                        Pattern pattern = Pattern.compile(regex);
                        Matcher matcher = pattern.matcher(entryTerm);
                        if (!matcher.find()) {
                            strings.add(entryTerm);
                        }
                    }
                }



            }

    }
        for (String string : strings) {
            List<JSONObject> jsonObjects = dataMongoTemplate.find(new Query(Criteria.where("entryTerms").is(string)), JSONObject.class, MongoTableNameEnum.EVIDENCE_MESH.getName());
            HashSet<String> strings1 = new HashSet<>();
            for (JSONObject jsonObject : jsonObjects) {
                strings1.add(jsonObject.getString("title"));
                if (strings1.size()>5){
                    break;
                }
            }
            objectObjectHashMap.put(string,strings1);
        }
        return objectObjectHashMap;
    }

}
