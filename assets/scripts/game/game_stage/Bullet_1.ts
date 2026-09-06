import { _decorator, Component, Node,Vec3,view } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('Bullet_1')
export class Bullet_1 extends Component {
    @property
    speed: number = 0
    w: number = 0
    h: number = 0
    targe:Vec3 = new Vec3(0,0,0)
    start() {
        let size = view.getVisibleSize()
        this.w = size.width
        this.h = size.height

    }

    randomPos() {
        //x y 在 正负 w和h之间 
        let x = Math.random() * this.w  - this.w/2
        let y = Math.random() * this.h  - this.h/2
        this.targe.set(x,y,0)
    }

    update(deltaTime: number) {
        //判断当前位置是否到达目标点，判断方法用小于0.5则表示到达了，到达则重新生成一个目标点
        if(this.node.position.clone().subtract(this.targe).length() < 2){
            this.randomPos()
        }

        //向目标点移动,匀速移动,不要用lerp
        
        let moveDir = this.targe.clone().subtract(this.node.position).normalize().multiplyScalar(this.speed*deltaTime)
        if(moveDir.length() > this.targe.clone().subtract(this.node.position).length()){
            this.node.position = this.targe.clone()
        }else{
            this.node.position = moveDir.add(this.node.position)
        }
        
    }

}