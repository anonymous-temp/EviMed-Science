package com.sentum.service.impl;

import com.alibaba.fastjson.JSONObject;
import com.mongodb.client.result.DeleteResult;
import com.sentum.feign.SystemFeign;
import com.sentum.pojo.ReleaseCollection;
import com.sentum.pojo.ReleaseData;
import com.sentum.pojo.dto.FileInfoUploadDto;
import com.sentum.pojo.vo.PageVo;
import com.sentum.pojo.vo.ReleaseDataVo;
import com.sentum.service.ReleaseService;
import com.sentum.util.ChangeMongoUtil;
import com.sentum.util.FastDFSClient;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.*;

/**
 * 实现类
 */
@Slf4j
@Service
public class ReleaseServiceImpl implements ReleaseService {
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private SystemFeign systemFeign;

    @Override
    public PageVo<ReleaseDataVo> releaseInfo(String searchInfo, Integer pageNum, Integer pageSize, Long userId) {
        PageVo<ReleaseDataVo> pageVo = new PageVo<>();
        Query query = new Query();
        if (StringUtils.isNotBlank(searchInfo)){
            List<Criteria> criteriaList = new ArrayList<>();
            List<String> rangeList = Arrays.asList("name", "drugName", "disease", "author", "workUnit", "department", "time");
            for (String txt : rangeList) {
                Criteria criteria = Criteria.where(txt).regex(searchInfo, "i");
                criteriaList.add(criteria);
            }
            Criteria criteria = new Criteria();
            criteria.orOperator(criteriaList.toArray(new Criteria[0]));
            query.addCriteria(criteria);
        }
        long count = ChangeMongoUtil.mongo.count(query, ReleaseData.class);
        query.with(PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.DESC, "time")));
        List<ReleaseData> releaseData = ChangeMongoUtil.mongo.find(query, ReleaseData.class);
        List<ReleaseDataVo> formData = new ArrayList<>();
        for (ReleaseData releaseDatum : releaseData) {
            ReleaseDataVo releaseDataVo = new ReleaseDataVo();
            BeanUtils.copyProperties(releaseDatum, releaseDataVo);
            //判断当前用户是否收藏改发布报告
            boolean exists = mongoTemplate.exists(new Query(Criteria.where("userId").is(userId).and("releaseId").is(releaseDatum.getId())), ReleaseCollection.class);
            if (exists){
                releaseDataVo.setCollectionStatus(true);
            }else {
                releaseDataVo.setCollectionStatus(false);
            }

            if (StringUtils.isNotBlank(releaseDatum.getFileName())){
                releaseDataVo.setName(releaseDatum.getFileName());
            }

            formData.add(releaseDataVo);
        }
        pageVo.setTotal(count);
        pageVo.setPageSize(pageSize);
        pageVo.setPageNum(pageNum);
        pageVo.setList(formData);
        pageVo.setPages((int) (count%pageSize==0?count/pageSize:count/pageSize+1));
        return pageVo;
    }

    @Override
    public JSONObject echoUserInfo(String token) {
        JSONObject result = new JSONObject();
        result.put("author", "");
        result.put("workUnit", "");
        result.put("department", "");
        result.put("userId", "");
        String userInfo = systemFeign.userInfo(token);
        if (StringUtils.isNotBlank(userInfo)){
            JSONObject jsonObject = JSONObject.parseObject(userInfo);
            Integer code = jsonObject.getInteger("code");
            if (code == 200){
                JSONObject data = jsonObject.getJSONObject("data");
                //用户名
                String userName = data.getString("userName");
                if (StringUtils.isNotBlank(userName)){
                    result.put("author", userName);
                }
                //机构
                String deptName = data.getString("deptName");
                if (StringUtils.isNotBlank(deptName)){
                    result.put("workUnit", deptName);
                }
                //部门
                String office = data.getString("office");
                if (StringUtils.isNotBlank(office)){
                    result.put("department", office);
                }
                String userId = data.getString("userId");
                if (StringUtils.isNotBlank(userId)){
                    result.put("userId", userId);
                }
            }
        }
        return result;
    }

    @Override
    public Boolean upload(FileInfoUploadDto fileInfoUploadDto) {
        ReleaseData releaseData = new ReleaseData();
        releaseData.setId(UUID.randomUUID().toString());
        //报告名称
        MultipartFile file = fileInfoUploadDto.getFile();
        String name = file.getOriginalFilename();
        if (!name.endsWith(".pdf")){
            throw new RuntimeException("文件格式不正确，请上传pdf格式文件");
        }
        releaseData.setName(name);
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
        //发布作者的唯一id
        releaseData.setUserId(fileInfoUploadDto.getUserId());
        //发布作者
        releaseData.setAuthor(StringUtils.isBlank(fileInfoUploadDto.getAuthor()) ? "" : fileInfoUploadDto.getAuthor());
        //发布单位
        releaseData.setWorkUnit(StringUtils.isBlank(fileInfoUploadDto.getWorkUnit()) ? "" : fileInfoUploadDto.getWorkUnit());
        //发布科室
        releaseData.setDepartment(StringUtils.isBlank(fileInfoUploadDto.getDepartment()) ? "" : fileInfoUploadDto.getDepartment());
        //发布简介信息
        releaseData.setProfile(StringUtils.isBlank(fileInfoUploadDto.getProfile()) ? "" : fileInfoUploadDto.getProfile());
        //疾病名称
        releaseData.setDisease(StringUtils.isBlank(fileInfoUploadDto.getDisease()) ? "" : fileInfoUploadDto.getDisease());
        //评价药品
        releaseData.setDrugName(StringUtils.isBlank(fileInfoUploadDto.getDrugName()) ? "" : fileInfoUploadDto.getDrugName());
        //发布时间
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
        releaseData.setTime(format.format(new Date()));
        releaseData.setFileName(StringUtils.isBlank(fileInfoUploadDto.getFileName())?"" : fileInfoUploadDto.getFileName());
        //文件所在位置
        InputStream inputStream = null;
        try {
            inputStream = file.getInputStream();
        } catch (IOException e) {
            e.printStackTrace();
        }
        String[] strings = FastDFSClient.uploadFile(inputStream, name);
        if (strings != null) {
            String filePath = strings[1];
            log.info("文件[{}]上传从成功，上传地址为[{}]", name, filePath);
            releaseData.setFilePath(filePath);
            ChangeMongoUtil.mongo.save(releaseData);
            return true;
        }
        return false;
    }

    @Override
    public Boolean collect(String releaseId, Long userId, Boolean status) {
        if (status){
            //收藏
            boolean exists = mongoTemplate.exists(new Query(Criteria.where("userId").is(userId).and("releaseId").is(releaseId)), ReleaseCollection.class);
            if (exists){
                throw new RuntimeException("请勿重复操作！");
            }
            ReleaseCollection releaseCollection = new ReleaseCollection(UUID.randomUUID().toString(), userId, releaseId, System.currentTimeMillis());
            try {
                mongoTemplate.save(releaseCollection);
                return true;
            } catch (Exception e) {
                return false;
            }

        }else {
            //取消收藏
            DeleteResult remove = mongoTemplate.remove(new Query(Criteria.where("userId").is(userId).and("releaseId").is(releaseId)), ReleaseCollection.class);
            return remove.getDeletedCount() > 0;
        }
    }
}
