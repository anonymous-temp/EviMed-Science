package com.sentum.evidencecomprehensive.controller;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.domain.vo.req.*;
import com.sentum.evidencecomprehensive.service.RetrievalService;
import com.sentum.evidencecomprehensive.utils.FormulaFeignUtil;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

@Slf4j
@Api(tags = "检索页面相关API")
@RestController
@RequestMapping("/evidence-api-based/retrieval-api")
public class RetrievalController {
    
    @Autowired
    private RetrievalService retrievalService;

    @GetMapping("/per-info")
    public DataResult personal(HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
            return DataResult.data(retrievalService.personal(token, userId));
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
    }
    
    @ApiOperation(value = "一筐式检索", notes = "search")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "condition", value = "检索条件", required = true)
    })
    @GetMapping("/basket-search")
    public DataResult basketTypeSearch(String condition, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(retrievalService.basketTypeSearch(condition, userId, request));
    }    
    
    @ApiOperation(value = "查询 Guide Hta Cde 纳入数量", notes = "search")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = " 课题 id", required = true)
    })
    @GetMapping("/search")
    public DataResult search(String id, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(retrievalService.search(id, userId));
    }
    
    @ApiOperation(value = "拼接检索式", notes = "retrieval")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "condition", value = "连接条件", required = false),
            @ApiImplicitParam(name = "originalWord", value = "被拼接的原始检索式", required = false),
            @ApiImplicitParam(name = "range", value = "检索条件", required = true),
            @ApiImplicitParam(name = "word", value = "拼接检索式", required = true)
    })
    @GetMapping("/mode")
    public DataResult SearchMode(String condition, String originalWord, String range, String word) {
        return DataResult.data(retrievalService.searchMode(condition, originalWord, range, word));
    }

    @ApiOperation(value = "验证检索式", notes = "retrieval")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "model", value = "拼接检索式", required = true)
    })
    @GetMapping("/verifyMode")
    public DataResult verifyMode(@RequestParam("model") String model) {
        return DataResult.data(retrievalService.verifyMode(model));
    }
    
    @ApiOperation(value = "获取文献指南纳入情况状态", notes = "acquire-status")
    @GetMapping("/acquire-status")
    @ApiImplicitParam(name = "id", value = "课题id")
    public DataResult acquireStatus(String id, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(retrievalService.acquireStatus(id, userId));
    }
    
    @ApiOperation(value = "确定报告生成文献指南的时间范围", notes = "confirm-year")
    @PostMapping("/confirm-year")
    public DataResult confirmLGYear(@RequestBody LGYearRequest lgYearRequest) {
        retrievalService.confirmLGYear(lgYearRequest);
        return DataResult.ok();
    }

    @ApiOperation(value = "获取文献分类列表", notes = "type-list")
    @GetMapping("/type-list")
    public DataResult typeList(){
        return DataResult.data(retrievalService.typeList());
    }

    @ApiOperation(value = "循证综合评价同义词", notes = "synonym")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "word", value = "检索词", required = true),
            @ApiImplicitParam(name = "range", value = "1-药品；2-疾病；3-参比药物；4-结局指标", required = true),
            @ApiImplicitParam(name = "isTranslate", value = "是否需要翻译 1翻译 2不翻译", required = true)
    })
    @GetMapping("/synonym")
    public DataResult synonym(String word, Integer range, Integer isTranslate){
        return DataResult.data(retrievalService.synonym(word, range, isTranslate));
    }

    @ApiOperation(value = "同义词反馈", notes = "synonym_feedback")
    @PostMapping("/synonym_feedback")
    public DataResult synonymFeedback(@RequestBody SynonymFeedbackRequest synonymFeedbackRequest, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        Boolean aBoolean = retrievalService.synonymFeedback(synonymFeedbackRequest, userId);
        if (aBoolean){
            return DataResult.ok();
        }
        return DataResult.error("反馈失败！！！");
    }

    @ApiOperation(value = "药品输入框，返回药品名称列表name，剂型列表dosageForm", notes = "synonym")
    @ApiImplicitParam(name = "drug", value = "用户输入药品名称", required = true)
    @GetMapping("/drug-info")
    public DataResult drugInfo(String drug){
        return DataResult.data(retrievalService.drugInfo(drug));
    }

    @ApiOperation(value = "获得疾病列表", notes = "disease")
    @PostMapping("/disease")
    public DataResult disease(@RequestBody DrugRequest drugRequest){
        return DataResult.data(retrievalService.disease(drugRequest));
    }

    @ApiOperation(value = "icd10疾病列表", notes = "icd10")
    @PostMapping("/icd10")
    public DataResult icd10(@RequestBody DrugRequest drugRequest){
        return DataResult.data(retrievalService.icd10(drugRequest));
    }

    @ApiOperation(value = "参比药物", notes = "reference-drug")
    @PostMapping("/reference-drug")
    public DataResult referenceDrug(@RequestBody DrugRequest drugRequest){
        return DataResult.data(retrievalService.referenceDrug(drugRequest));
    }

    @ApiOperation(value = "结局指标", notes = "outcome")
    @PostMapping("/outcome")
    public DataResult outcome(@RequestBody OutcomeRequest outcomeRequest){
        return DataResult.data(retrievalService.outcome(outcomeRequest));
    }

    @ApiOperation(value = "保存用户检索条件", notes = "save-condition")
    @PostMapping("/save-condition")
    public DataResult saveCondition(@RequestBody ConditionRequest conditionRequest, HttpServletRequest request, HttpServletResponse response){
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(retrievalService.saveCondition(conditionRequest, userId, request));
    }

    @ApiOperation(value = "回显用户的检索信息", notes = "echo")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/echo")
    public DataResult echo(String id) {
        return DataResult.data(retrievalService.echo(id));
    }

    @ApiOperation(value = "检索式检索", notes = "retrieval")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "query", value = "检索式", required = true),
            @ApiImplicitParam(name = "type", value = "1文献，2指南，3说明书，4临床试验", required = true)
    })
    @GetMapping("/retrieval")
    public String retrieval(String query, Integer type) {
        //SearchFormula searchFormula = new SearchFormula();
        String name = "";
        switch (type) {
            case 1:
                name = "文献";
                break;
            case 2:
                name = "指南";
                break;
            case 3:
                name = "说明书";
                break;
            case 4:
                name = "临床试验";
                break;
            default:
                break;
        }
        log.info("[{}]-[{}]", name, query);
        return FormulaFeignUtil.formula(query, type);
        //BoolQueryBuilder execute = searchFormula.execute(query, type);
        //return execute.toString();
    }

    @ApiOperation(value = "检索式检索", notes = "retrieval")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "query", value = "检索式", required = true),
            @ApiImplicitParam(name = "type", value = "1文献，2指南，3说明书，4临床试验", required = true)
    })
    @PostMapping("/large-retrieval")
    public String largeRetrieval(@RequestBody MultiValueMap<String,String> map) {
        //SearchFormula searchFormula = new SearchFormula();
        String mapType = map.get("type").get(0);
        int type = 1;
        if (mapType != null && StrUtil.isNotBlank(mapType)) {
            type = Integer.parseInt(mapType);
        }
        String query = map.get("query").get(0);
        String name = "";
        switch (type) {
            case 1:
                name = "文献";
                break;
            case 2:
                name = "指南";
                break;
            case 3:
                name = "说明书";
                break;
            case 4:
                name = "临床试验";
                break;
            default:
                break;
        }
        log.info("[{}]-[{}]", name, query);
        return FormulaFeignUtil.formula(query, type);
        //BoolQueryBuilder execute = searchFormula.execute(query, type);
        //return execute.toString();
    }
}
