package com.sentum.drugsafe.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.pojo.PicoResult;
import com.sentum.drugsafe.service.InstructionService;
import com.sentum.drugsafe.trans.DeeplApi;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashSet;
import java.util.List;

import static java.lang.Thread.sleep;

@Slf4j
@RestController
@RequestMapping("/alert/instruction")
public class InstructionController {

    private static String requiredMongoUri(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException(name + " must be provided by the runtime secret store");
        }
        return value.trim();
    }

    @Autowired
    private InstructionService instructionService;



    @ApiOperation(value = "列表", notes = "列表")
    @GetMapping("/tree")
    public PicoResult getTree(String id) {
        return PicoResult.data(instructionService.getInstructionTree(id));
    }



    @ApiOperation(value = "改版说明书列表", notes = "list")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索条件id", required = true),
            @ApiImplicitParam(name = "oneLevelTerm", value = "一级选项", required = false),
            @ApiImplicitParam(name = "twoLevelTerm", value = "二级选项", required = false),
            @ApiImplicitParam(name = "threeLevelTerm", value = "三级选项", required = false),
            @ApiImplicitParam(name = "threeLevelTerm", value = "三级选项", required = false),
            @ApiImplicitParam(name = "pageSize", value = "页大小", required = false),
            @ApiImplicitParam(name = "pageNum", value = "页位置", required = false),
            @ApiImplicitParam(name = "search", value = "", required = false),
    })
    @GetMapping("/navigationList")
    public PicoResult navigationList(String id, String oneLevelTerm, String twoLevelTerm, String threeLevelTerm, @RequestParam(defaultValue = "10") Integer pageSize, @RequestParam(defaultValue = "1") Integer pageNum, String search) {
        return PicoResult.data(instructionService.navigationList(id, oneLevelTerm, twoLevelTerm, threeLevelTerm, pageSize, pageNum, search));
    }



    @ApiOperation(value = "翻译", notes = "翻译")
    @GetMapping("/drug_translate")
    public String translate() {
        MongoTemplate dataMongoTemplate = new MongoTemplate(new SimpleMongoClientDatabaseFactory(requiredMongoUri("EVIMED_MONGODB_URI_ORIGINAL_INDIVIDUAL_CASE_3")));
        long instructionsCleaning = dataMongoTemplate.count(new Query(), "hist");
        long page = (instructionsCleaning ) / 1000 + 1;
        for (int i = 0; i < page; i++) {
            List<JSONObject> instructionsCleaning1 = dataMongoTemplate.find(new Query().skip(i * 1000).limit(1000), JSONObject.class, "hist");
            int count = 0;
            for (JSONObject jsonObject : instructionsCleaning1) {
                String string = jsonObject.getString("原疾患等");
                if (StringUtils.isNotEmpty(string)){
                    List<JSONObject> jsonObjects = dataMongoTemplate.find(new Query(Criteria.where("jp").is(string)), JSONObject.class, "hist_jp_zh");
                    if (jsonObjects.size()==0){
                        JSONObject jsonObject1 = new JSONObject();
                        jsonObject1.put("jp",string);
                        String trans = DeeplApi.trans(string);
                        jsonObject1.put("zh", trans);
                        dataMongoTemplate.insert(jsonObject1,"hist_jp_zh");
                        log.info("翻译词：{}:{}",string,trans);
                        try {
                            sleep(100);
                        } catch (InterruptedException e) {
                            throw new RuntimeException(e);
                        }
                    }
                    count++;
                    log.info("翻译成功:{}",(i * 1000+count));
                }
            }
        }

        return "success";


    }




}
